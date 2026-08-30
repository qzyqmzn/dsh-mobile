package io.github.sayach.dshmobile

import java.util.Locale

/** Classifies provider and user-owned remote hosts without treating LAN origins as remote. */
internal object RemoteHostPolicy {
    private val supportedSuffixes = listOf(
        ".ts.net",
        ".cpolar.cn",
        ".cpolar.io",
        ".cpolar.top",
        ".cpolar.com",
    )

    /** Returns whether the host belongs to a supported remote tunnel provider. */
    fun isSupported(host: String): Boolean {
        val normalized = host.lowercase(Locale.ROOT)
        return supportedSuffixes.any(normalized::endsWith)
    }

    /** Returns whether an HTTPS host can represent a user-owned public remote endpoint. */
    fun isRemoteCandidate(host: String): Boolean {
        val normalized = host.lowercase(Locale.ROOT).trimEnd('.')
        if (isSupported(normalized)) return true
        if (normalized.isEmpty() || normalized.contains(':') || normalized == "localhost"
            || normalized.endsWith(".local") || normalized.endsWith(".lan")
            || normalized.endsWith(".home") || normalized.endsWith(".internal")) return false
        val labels = normalized.split('.')
        if (labels.size < 2 || labels.all { label -> label.all(Char::isDigit) }) return false
        return labels.all { label ->
            label.isNotEmpty() && label.length <= 63
                && label.first().isLetterOrDigit() && label.last().isLetterOrDigit()
                && label.all { character -> character.isLetterOrDigit() || character == '-' }
        }
    }

    /** Returns whether this origin is valid for the selected connection mode. */
    fun isAllowed(mode: AccessMode, host: String): Boolean = when (mode) {
        AccessMode.LAN -> !isRemoteCandidate(host)
        AccessMode.REMOTE -> isRemoteCandidate(host)
    }

    /** Returns whether the host uses Tailscale and needs the mainland-China connectivity notice. */
    fun needsTailscaleVpnNotice(host: String): Boolean =
        host.lowercase(Locale.ROOT).endsWith(".ts.net")
}
