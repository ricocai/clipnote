/*
** 2001-09-15
**
** The author disclaims copyright to this source code.  In place of
** a legal notice, here is a blessing:
**
**    May you do good and not evil.
**    May you find forgiveness for yourself and forgive others.
**    May you share freely, never taking more than you give.
**
*************************************************************************
*/
#if defined(SQLITE_ENABLE_ICU) || defined(SQLITE_ENABLE_ICU_COLLATIONS)
/************** Include sqliteicu.h in the middle of main.c ******************/
/************** Begin file sqliteicu.h ***************************************/
/*
** 2008 May 26`
**
** The author disclaims copyright to this source code.  In place of
** a legal notice, here is a blessing:
**
**    May you do good and not evil.
**    May you find forgiveness for yourself and forgive others.
**    May you share freely, never taking more than you give.
**
******************************************************************************
**
** This header file is used by programs that want to link against the
** ICU extension.  All it does is declare the sqlite3IcuInit() interface.
*/
#include "sqlite3sym.h"
#include "sqlite3tokenizer.h"

#ifdef __cplusplus
extern "C" {
#endif

SQLITE_API int sqlite3IcuInit(sqlite3 *db);

/************** End of sqliteicu.h *******************************************/
/************** Continuing where we left off in main.c ***********************/
#endif

#ifdef SQLITE_ENABLE_ICU
SQLITE_API void sqlite3Fts3IcuTokenizerModule(sqlite3_tokenizer_module const**ppModule);
#endif

#ifdef __cplusplus
}  /* end of the 'extern "C"' block */
#endif