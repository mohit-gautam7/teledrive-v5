package app.teledrive.codex.backup

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.io.IOException

object BackupNetwork {
    fun fileOriginAllowed(origin: String): Boolean = runCatching {
        val uri = java.net.URI(origin)
        uri.scheme == "https" && !uri.host.isNullOrEmpty() &&
            !uri.host.endsWith(".vercel.app") && uri.userInfo == null && uri.query == null && uri.fragment == null &&
            (uri.path.isNullOrEmpty() || uri.path == "/")
    }.getOrDefault(false)
    fun type(context: Context): String {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return "offline"
        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
            else -> "other"
        }
    }

    fun allows(mode: String, type: String): Boolean =
        type != "offline" && when (mode) {
            "both" -> true
            "wifi" -> type == "wifi"
            "mobile" -> type == "mobile"
            else -> false
        }

    fun requireAllowed(context: Context, prefs: BackupPrefs) {
        if (!prefs.enabled) throw IOException("Automatic backup is off.")
        if (!allows(prefs.networkMode, type(context))) throw IOException("Waiting for the selected backup network (${prefs.networkMode}).")
    }
}
