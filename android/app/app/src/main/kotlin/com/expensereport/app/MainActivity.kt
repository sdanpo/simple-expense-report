package com.expensereport.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.widget.Button
import android.widget.Toast
import androidx.activity.result.contracts.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * The single screen: a WebView onto the existing dashboard, plus the onboarding
 * actions (sign in, grant photo access, sync now). After setup the app is invisible —
 * photos and email flow on their own.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs

    private val mediaPermission =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            Manifest.permission.READ_MEDIA_IMAGES
        else
            Manifest.permission.READ_EXTERNAL_STORAGE

    private val requestMedia =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                WorkScheduler.scheduleAll(this)
                toast("Photo sync is on")
            } else {
                toast("Photo access is needed to capture receipts")
            }
            refreshOnboarding()
        }

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* optional */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_main)

        val web = findViewById<WebView>(R.id.webview)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.loadUrl(BuildConfig.BASE_URL)

        findViewById<Button>(R.id.btnSignIn).setOnClickListener { doSignIn() }
        findViewById<Button>(R.id.btnPermission).setOnClickListener { requestMedia.launch(mediaPermission) }
        findViewById<Button>(R.id.btnSyncNow).setOnClickListener {
            WorkScheduler.syncNow(this); toast("Syncing…")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        // If photo access is already granted (returning user), make sure work is armed.
        if (hasMediaPermission()) WorkScheduler.scheduleAll(this)
        refreshOnboarding()
    }

    private fun hasMediaPermission() =
        ContextCompat.checkSelfPermission(this, mediaPermission) == PackageManager.PERMISSION_GRANTED

    private fun refreshOnboarding() {
        findViewById<Button>(R.id.btnPermission).isEnabled = !hasMediaPermission()
        findViewById<Button>(R.id.btnSignIn).isEnabled = prefs.signedInEmail == null
    }

    private fun doSignIn() {
        lifecycleScope.launch {
            try {
                val result = GoogleAuth.signIn(this@MainActivity)
                prefs.signedInEmail = result.email
                toast("Signed in as ${result.email}")
                refreshOnboarding()
            } catch (e: Exception) {
                toast("Sign-in unavailable: ${e.message}")
            }
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
