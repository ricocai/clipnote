// G7 设备侧探测代理：把 OpenHarmony 同版本 SQLite 以 node:sqlite 兼容 API 暴露给 Node。
// 仅实现 g7-search 探测脚本用到的 DatabaseSync 子集：exec / prepare + run/all/get。
#include <node_api.h>
#include <sqlite3.h>
#include <cstring>
#include <string>
#include <vector>

namespace {

napi_ref g_dbCtor;
napi_ref g_stmtCtor;

struct Db {
  sqlite3 *h;
};
struct Stmt {
  sqlite3_stmt *h;
  sqlite3 *db;
};

void ThrowErr(napi_env env, const char *prefix, sqlite3 *h) {
  std::string msg = std::string(prefix) + ": " + sqlite3_errmsg(h);
  napi_value err;
  napi_create_string_utf8(env, msg.c_str(), msg.size(), &err);
  napi_value errorObj;
  napi_create_error(env, nullptr, err, &errorObj);
  napi_throw(env, errorObj);
}

bool BindParams(napi_env env, sqlite3_stmt *st, size_t argc, napi_value *args) {
  sqlite3_reset(st);
  sqlite3_clear_bindings(st);
  int n = sqlite3_bind_parameter_count(st);
  if (static_cast<int>(argc) < n) {
    napi_throw_error(env, nullptr, "too few bind parameters");
    return false;
  }
  for (int i = 0; i < n; i++) {
    napi_valuetype t;
    napi_typeof(env, args[i], &t);
    switch (t) {
      case napi_number: {
        double v;
        napi_get_value_double(env, args[i], &v);
        sqlite3_bind_double(st, i + 1, v);
        break;
      }
      case napi_string: {
        size_t len = 0;
        napi_get_value_string_utf8(env, args[i], nullptr, 0, &len);
        std::string buf(len, '\0');
        napi_get_value_string_utf8(env, args[i], buf.data(), len + 1, &len);
        sqlite3_bind_text64(st, i + 1, buf.data(), len, SQLITE_TRANSIENT, SQLITE_UTF8);
        break;
      }
      case napi_null:
      case napi_undefined:
        sqlite3_bind_null(st, i + 1);
        break;
      case napi_bigint: {
        int64_t v;
        bool lossless;
        napi_get_value_bigint_int64(env, args[i], &v, &lossless);
        sqlite3_bind_int64(st, i + 1, v);
        break;
      }
      default:
        napi_throw_error(env, nullptr, "unsupported bind parameter type");
        return false;
    }
  }
  return true;
}

napi_value ColumnValue(napi_env env, sqlite3_stmt *st, int col) {
  switch (sqlite3_column_type(st, col)) {
    case SQLITE_INTEGER: {
      int64_t v = sqlite3_column_int64(st, col);
      napi_value out;
      if (v >= -9007199254740991LL && v <= 9007199254740991LL) {
        napi_create_double(env, static_cast<double>(v), &out);
      } else {
        napi_create_bigint_int64(env, v, &out);
      }
      return out;
    }
    case SQLITE_FLOAT: {
      napi_value out;
      napi_create_double(env, sqlite3_column_double(st, col), &out);
      return out;
    }
    case SQLITE_TEXT: {
      const char *p = reinterpret_cast<const char *>(sqlite3_column_text(st, col));
      int n = sqlite3_column_bytes(st, col);
      napi_value out;
      napi_create_string_utf8(env, p ? p : "", n, &out);
      return out;
    }
    case SQLITE_NULL:
    default: {
      napi_value out;
      napi_get_null(env, &out);
      return out;
    }
  }
}

napi_value DbCtor(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_value jsthis;
  napi_get_cb_info(env, info, &argc, args, &jsthis, nullptr);

  std::string path(":memory:");
  if (argc >= 1) {
    size_t len = 0;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    path.resize(len);
    napi_get_value_string_utf8(env, args[0], path.data(), len + 1, &len);
  }

  Db *d = new Db();
  int rc = sqlite3_open(path.c_str(), &d->h);
  if (rc != SQLITE_OK) {
    std::string msg = "open failed: " + std::string(sqlite3_errmsg(d->h));
    sqlite3_close(d->h);
    delete d;
    napi_throw_error(env, nullptr, msg.c_str());
    return nullptr;
  }
  sqlite3_busy_timeout(d->h, 5000);
  napi_wrap(env, jsthis, d,
            [](napi_env, void *data, void *) { Db *d = static_cast<Db *>(data); sqlite3_close(d->h); delete d; },
            nullptr, nullptr);
  return jsthis;
}

napi_value DbExec(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_value jsthis;
  napi_get_cb_info(env, info, &argc, args, &jsthis, nullptr);
  Db *d;
  napi_unwrap(env, jsthis, reinterpret_cast<void **>(&d));
  size_t len = 0;
  napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
  std::string sql(len, '\0');
  napi_get_value_string_utf8(env, args[0], sql.data(), len + 1, &len);
  char *err = nullptr;
  int rc = sqlite3_exec(d->h, sql.c_str(), nullptr, nullptr, &err);
  if (rc != SQLITE_OK) {
    ThrowErr(env, err ? err : "exec failed", d->h);
    sqlite3_free(err);
    return nullptr;
  }
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

napi_value DbPrepare(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_value jsthis;
  napi_get_cb_info(env, info, &argc, args, &jsthis, nullptr);
  Db *d;
  napi_unwrap(env, jsthis, reinterpret_cast<void **>(&d));
  size_t len = 0;
  napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
  std::string sql(len, '\0');
  napi_get_value_string_utf8(env, args[0], sql.data(), len + 1, &len);

  Stmt *s = new Stmt();
  s->db = d->h;
  int rc = sqlite3_prepare_v2(d->h, sql.c_str(), -1, &s->h, nullptr);
  if (rc != SQLITE_OK) {
    ThrowErr(env, "prepare failed", d->h);
    delete s;
    return nullptr;
  }

  napi_value ctor;
  napi_get_reference_value(env, g_stmtCtor, &ctor);
  napi_value out;
  napi_new_instance(env, ctor, 0, nullptr, &out);
  napi_wrap(env, out, s,
            [](napi_env, void *data, void *) {
              Stmt *s = static_cast<Stmt *>(data);
              if (s->h) sqlite3_finalize(s->h);
              delete s;
            },
            nullptr, nullptr);
  return out;
}

napi_value StmtRun(napi_env env, napi_callback_info info) {
  size_t argc = 32;
  napi_value args[32];
  napi_value jsthis;
  napi_get_cb_info(env, info, &argc, args, &jsthis, nullptr);
  Stmt *s;
  napi_unwrap(env, jsthis, reinterpret_cast<void **>(&s));
  if (!BindParams(env, s->h, argc, args)) return nullptr;
  int rc = sqlite3_step(s->h);
  if (rc != SQLITE_ROW && rc != SQLITE_DONE) {
    ThrowErr(env, "step failed", s->db);
    return nullptr;
  }
  napi_value out;
  napi_create_object(env, &out);
  napi_value changes;
  napi_create_double(env, static_cast<double>(sqlite3_changes64(s->db)), &changes);
  napi_set_named_property(env, out, "changes", changes);
  return out;
}

napi_value RowToObject(napi_env env, sqlite3_stmt *st) {
  napi_value obj;
  napi_create_object(env, &obj);
  int cols = sqlite3_column_count(st);
  for (int i = 0; i < cols; i++) {
    const char *name = sqlite3_column_name(st, i);
    napi_value val = ColumnValue(env, st, i);
    napi_set_named_property(env, obj, name ? name : "?", val);
  }
  return obj;
}

napi_value StmtAll(napi_env env, napi_callback_info info) {
  size_t argc = 32;
  napi_value args[32];
  napi_value jsthis;
  napi_get_cb_info(env, info, &argc, args, &jsthis, nullptr);
  Stmt *s;
  napi_unwrap(env, jsthis, reinterpret_cast<void **>(&s));
  if (!BindParams(env, s->h, argc, args)) return nullptr;
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t idx = 0;
  int rc;
  while ((rc = sqlite3_step(s->h)) == SQLITE_ROW) {
    napi_set_element(env, arr, idx++, RowToObject(env, s->h));
  }
  if (rc != SQLITE_DONE) {
    ThrowErr(env, "step failed", s->db);
    return nullptr;
  }
  return arr;
}

napi_value StmtGet(napi_env env, napi_callback_info info) {
  size_t argc = 32;
  napi_value args[32];
  napi_value jsthis;
  napi_get_cb_info(env, info, &argc, args, &jsthis, nullptr);
  Stmt *s;
  napi_unwrap(env, jsthis, reinterpret_cast<void **>(&s));
  if (!BindParams(env, s->h, argc, args)) return nullptr;
  int rc = sqlite3_step(s->h);
  if (rc == SQLITE_ROW) return RowToObject(env, s->h);
  if (rc != SQLITE_DONE) {
    ThrowErr(env, "step failed", s->db);
    return nullptr;
  }
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value dbProto;
  napi_create_object(env, &dbProto);
  napi_value fnExec, fnPrepare;
  napi_create_function(env, "exec", NAPI_AUTO_LENGTH, DbExec, nullptr, &fnExec);
  napi_create_function(env, "prepare", NAPI_AUTO_LENGTH, DbPrepare, nullptr, &fnPrepare);
  napi_set_named_property(env, dbProto, "exec", fnExec);
  napi_set_named_property(env, dbProto, "prepare", fnPrepare);

  napi_value dbCtor;
  napi_create_function(env, "DatabaseSync", NAPI_AUTO_LENGTH, DbCtor, nullptr, &dbCtor);
  napi_set_named_property(env, dbCtor, "prototype", dbProto);
  napi_create_reference(env, dbCtor, 1, &g_dbCtor);

  napi_value stProto;
  napi_create_object(env, &stProto);
  napi_value fnRun, fnAll, fnGet;
  napi_create_function(env, "run", NAPI_AUTO_LENGTH, StmtRun, nullptr, &fnRun);
  napi_create_function(env, "all", NAPI_AUTO_LENGTH, StmtAll, nullptr, &fnAll);
  napi_create_function(env, "get", NAPI_AUTO_LENGTH, StmtGet, nullptr, &fnGet);
  napi_set_named_property(env, stProto, "run", fnRun);
  napi_set_named_property(env, stProto, "all", fnAll);
  napi_set_named_property(env, stProto, "get", fnGet);

  napi_value stCtor;
  napi_create_function(env, "StatementSync", NAPI_AUTO_LENGTH,
                       [](napi_env env, napi_callback_info info) {
                         napi_value jsthis;
                         napi_get_cb_info(env, info, nullptr, nullptr, &jsthis, nullptr);
                         return jsthis;
                       },
                       nullptr, &stCtor);
  napi_set_named_property(env, stCtor, "prototype", stProto);
  napi_create_reference(env, stCtor, 1, &g_stmtCtor);

  napi_set_named_property(env, exports, "DatabaseSync", dbCtor);
  return exports;
}

}  // namespace

NAPI_MODULE_INIT() { return Init(env, exports); }
