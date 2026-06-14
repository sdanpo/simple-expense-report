package com.expensereport.app

import android.content.Context

/**
 * Small key/value store for the MediaStore checkpoint and the upload token.
 * NOTE: for production, move the token to EncryptedSharedPreferences (security-crypto).
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("expense_report", Context.MODE_PRIVATE)

    var lastSeenMediaId: Long
        get() = sp.getLong(KEY_CHECKPOINT, 0L)
        set(v) = sp.edit().putLong(KEY_CHECKPOINT, v).apply()

    /** Falls back to the build-time token during the team-testing phase. */
    var token: String
        get() = sp.getString(KEY_TOKEN, "").orEmpty().ifEmpty { BuildConfig.INBOUND_TOKEN }
        set(v) = sp.edit().putString(KEY_TOKEN, v).apply()

    var signedInEmail: String?
        get() = sp.getString(KEY_EMAIL, null)
        set(v) = sp.edit().putString(KEY_EMAIL, v).apply()

    companion object {
        private const val KEY_CHECKPOINT = "checkpoint"
        private const val KEY_TOKEN = "token"
        private const val KEY_EMAIL = "email"
    }
}
