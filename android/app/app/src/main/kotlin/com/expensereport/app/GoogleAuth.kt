package com.expensereport.app

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential

/**
 * One-tap Google Sign-In via Credential Manager. On Android the account is already
 * on the device, so this is essentially "pick your account". It yields a Google ID
 * token + email used to identify the user.
 *
 * Current backend auth is a bearer token (BuildConfig.INBOUND_TOKEN) for the
 * team-testing phase; this sign-in establishes identity now and is the hook for the
 * future server-side Google ID-token verification (no code change needed in the
 * upload path — only the token source changes).
 */
object GoogleAuth {
    data class Result(val email: String?, val idToken: String)

    suspend fun signIn(context: Context): Result {
        val webClientId = BuildConfig.GOOGLE_WEB_CLIENT_ID
        require(webClientId.isNotEmpty()) {
            "GOOGLE_WEB_CLIENT_ID is not set (local.properties). Sign-in is optional during testing."
        }
        val option = GetGoogleIdOption.Builder()
            .setServerClientId(webClientId)
            .setFilterByAuthorizedAccounts(false)
            .build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()

        val response = CredentialManager.create(context).getCredential(context, request)
        val cred = GoogleIdTokenCredential.createFrom(response.credential.data)
        return Result(email = cred.id, idToken = cred.idToken)
    }
}
