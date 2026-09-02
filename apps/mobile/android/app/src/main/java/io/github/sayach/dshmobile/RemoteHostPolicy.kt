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
        if (isPublicIpv4(normalized)) return true
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

    /** Accept a literal IPv4 as remote only when it is outside local and reserved ranges. */
    private fun isPublicIpv4(host: String): Boolean {
        val octets = host.split('.').takeIf { it.size == 4 }?.map { part ->
            if (!part.matches(Regex("^(?:0|[1-9][0-9]{0,2})$"))) return false
            part.toInt().takeIf { it in 0..255 } ?: return false
        } ?: return false
        val first = octets[0]
        val second = octets[1]
        if (first == 0 || first == 10 || first == 127 || first >= 224) return false
        if (first == 100 && second in 64..127) return false
        if (first == 169 && second == 254) return false
        if (first == 172 && second in 16..31) return false
        if (first == 192 && second == 168) return false
        if (first == 198 && second in 18..19) return false
        return true
    }
}
