/*
 * Copyright (c) 2021 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef SQLITE3SYM_H
#define SQLITE3SYM_H

#define SQLITE3_EXPORT_SYMBOLS
#define SQLITE_OMIT_LOAD_EXTENSION

// We extend the original purpose of the "sqlite3ext.h".
#include "sqlite3ext.h"

struct sqlite3_api_routines_hw {
  int (*initialize)();
  int (*config)(int,...);
  int (*key)(sqlite3*,const void*,int);
  int (*key_v2)(sqlite3*,const char*,const void*,int);
  int (*rekey)(sqlite3*,const void*,int);
  int (*rekey_v2)(sqlite3*,const char*,const void*,int);
};

extern const struct sqlite3_api_routines_hw *sqlite3_export_hw_symbols;
#define sqlite3_initialize          sqlite3_export_hw_symbols->initialize
#define sqlite3_config              sqlite3_export_hw_symbols->config
#define sqlite3_key                 sqlite3_export_hw_symbols->key
#define sqlite3_key_v2              sqlite3_export_hw_symbols->key_v2
#define sqlite3_rekey               sqlite3_export_hw_symbols->rekey
#define sqlite3_rekey_v2            sqlite3_export_hw_symbols->rekey_v2

#endif
