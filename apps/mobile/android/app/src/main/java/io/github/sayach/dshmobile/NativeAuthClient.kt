package io.github.sayach.dshmobile

import org.json.JSONObject
import org.json.JSONException
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager

internal data class NativeSession(
    val origin: GatewayOrigin,
    val instanceId: String,
    val deviceId: String,
    val deviceToken: String?,
    val deviceExpiresAt: Long?,
    val sessionToken: String,
    val csrfToken: String,
    val sessionExpiresAt: Long,
)

internal enum class NativeAuthFailureKind {
    PAIRING_EXPIRED,
    DEVICE_LIMIT,
    RATE_LIMITED,
    TIMEOUT,
    TLS,
    NETWORK,
    SERVER_UNAVAILABLE,
    INVALID_RESPONSE,
}

internal class NativeAuthFailure(
    val kind: NativeAuthFailureKind,
    cause: Throwable? = null,
) : IOException(kind.name, cause)

internal fun nativeAuthFailureForStatus(status: Int): NativeAuthFailureKind = when (status) {
    HttpURLConnection.HTTP_UNAUTHORIZED, HttpURLConnection.HTTP_FORBIDDEN -> NativeAuthFailureKind.PAIRING_EXPIRED
    HttpURLConnection.HTTP_CONFLICT -> NativeAuthFailureKind.DEVICE_LIMIT
    429 -> NativeAuthFailureKind.RATE_LIMITED
    in 500..599 -> NativeAuthFailureKind.SERVER_UNAVAILABLE
    else -> NativeAuthFailureKind.INVALID_RESPONSE
}

internal data class NativeAuthTimeouts(
    val bootstrapConnectMs: Int,
    val bootstrapReadMs: Int,
    val authConnectMs: Int,
    val authReadMs: Int,
)

/** Keeps LAN failures fast while allowing mobile networks and remote relays enough time to respond. */
internal fun nativeAuthTimeouts(host: String): NativeAuthTimeouts =
    if (RemoteHostPolicy.isRemoteCandidate(host)) {
        NativeAuthTimeouts(
            bootstrapConnectMs = 3_000,
            bootstrapReadMs = 5_000,
            authConnectMs = 10_000,
            authReadMs = 30_000,
        )
    } else {
        NativeAuthTimeouts(
            bootstrapConnectMs = 500,
            bootstrapReadMs = 800,
            authConnectMs = 3_000,
            authReadMs = 5_000,
        )
    }

/** Uses platform TLS validation for native pairing and renewal. */
internal object NativeAuthClient {
    fun pair(
        origin: GatewayOrigin,
        token: String,
        caCertificate: ByteArray?,
        expectedInstanceId: String,
    ): NativeSession = post(
        origin,
        "/mobile-access/auth/native-pair",
        JSONObject().put("token", token).put("label", "DeepSeek Harness Android"),
        caCertificate,
        expectedInstanceId,
        requireDeviceCredential = true,
    )

    fun renew(
        origin: GatewayOrigin,
        deviceToken: String,
        caCertificate: ByteArray?,
        expectedInstanceId: String,
    ): NativeSession = post(
        origin,
        "/mobile-access/auth/native-renew",
        JSONObject().put("deviceToken", deviceToken),
        caCertificate,
        expectedInstanceId,
        requireDeviceCredential = false,
    )

    /** Fetches the public CA without credentials; the caller must fingerprint-bind it before use. */
    fun fetchPairingCa(origin: GatewayOrigin): ByteArray = requireNotNull(
        bootstrapGet(origin, "/mobile-access/ca.cer", 16 * 1024),
    )

    /** Compatibility discovery probe. Its metadata remains untrusted until pairing-key verification. */
    fun fetchDiscovery(origin: GatewayOrigin): JSONObject = JSONObject(
        requireNotNull(bootstrapGet(origin, "/mobile-access/discovery", 8 * 1024)).toString(Charsets.UTF_8),
    )

    /** Reads optional compatibility metadata. A 404 identifies a compatible legacy gateway. */
    fun fetchMetadata(origin: GatewayOrigin): GatewayMetadata? {
        val bytes = bootstrapGet(origin, "/mobile-access/metadata", 8 * 1024, allowMissing = true) ?: return null
        return parseGatewayMetadata(JSONObject(bytes.toString(Charsets.UTF_8)))
    }

    private fun bootstrapGet(
        origin: GatewayOrigin,
        path: String,
        maxBytes: Int,
        allowMissing: Boolean = false,
    ): ByteArray? {
        val trustManager = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        }
        val context = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), SecureRandom())
        }
        val connection = URL(origin.serialized + path).openConnection() as HttpsURLConnection
        val timeouts = nativeAuthTimeouts(origin.host)
        try {
            connection.sslSocketFactory = context.socketFactory
            connection.connectTimeout = timeouts.bootstrapConnectMs
            connection.readTimeout = timeouts.bootstrapReadMs
            connection.instanceFollowRedirects = false
            if (allowMissing && connection.responseCode == HttpURLConnection.HTTP_NOT_FOUND) return null
            if (connection.responseCode != HttpURLConnection.HTTP_OK) error("Bootstrap request failed (${connection.responseCode})")
            val length = connection.contentLengthLong
            if (length > maxBytes) error("Bootstrap response is too large")
            val body = connection.inputStream.use { readAtMost(it, maxBytes + 1) }
            if (body.size > maxBytes) error("Bootstrap response is too large")
            return body
        } finally {
            connection.disconnect()
        }
    }

    private fun post(
        origin: GatewayOrigin,
        path: String,
        body: JSONObject,
        caCertificate: ByteArray?,
        expectedInstanceId: String,
        requireDeviceCredential: Boolean,
    ): NativeSession {
        val connection = URL(origin.serialized + path).openConnection() as HttpsURLConnection
        val timeouts = nativeAuthTimeouts(origin.host)
        try {
            if (caCertificate != null) connection.sslSocketFactory = PinnedTls.socketFactory(caCertificate)
            connection.requestMethod = "POST"
            connection.connectTimeout = timeouts.authConnectMs
            connection.readTimeout = timeouts.authReadMs
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Origin", origin.serialized)
            connection.setRequestProperty("Sec-Fetch-Site", "same-origin")
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            if (connection.responseCode !in 200..299) {
                throw NativeAuthFailure(nativeAuthFailureForStatus(connection.responseCode))
            }
            if (!connection.contentType.orEmpty().substringBefore(';').equals("application/json", ignoreCase = true)) {
                throw NativeAuthFailure(NativeAuthFailureKind.INVALID_RESPONSE)
            }
            if (connection.contentLengthLong > MAX_NATIVE_AUTH_RESPONSE_BYTES) {
                throw NativeAuthFailure(NativeAuthFailureKind.INVALID_RESPONSE)
            }
            return connection.inputStream.use { input ->
                parseNativeSessionResponse(
                    input = input,
                    origin = origin,
                    expectedInstanceId = expectedInstanceId,
                    requireDeviceCredential = requireDeviceCredential,
                )
            }
        } catch (failure: NativeAuthFailure) {
            throw failure
        } catch (failure: SocketTimeoutException) {
            throw NativeAuthFailure(NativeAuthFailureKind.TIMEOUT, failure)
        } catch (failure: SSLException) {
            throw NativeAuthFailure(NativeAuthFailureKind.TLS, failure)
        } catch (failure: JSONException) {
            throw NativeAuthFailure(NativeAuthFailureKind.INVALID_RESPONSE, failure)
        } catch (failure: IOException) {
            throw NativeAuthFailure(NativeAuthFailureKind.NETWORK, failure)
        } finally {
            connection.disconnect()
        }
    }

}

internal const val MAX_NATIVE_AUTH_RESPONSE_BYTES = 32 * 1024
private val INSTANCE_ID_PATTERN = Regex("^[a-f0-9]{64}$")
private val DEVICE_ID_PATTERN = Regex("^[a-f0-9]{32}$")
private val OPAQUE_TOKEN_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")

/** Parses one bounded native-auth response and binds it to the request origin and expected DSH instance. */
internal fun parseNativeSessionResponse(
    input: InputStream,
    origin: GatewayOrigin,
    expectedInstanceId: String,
    requireDeviceCredential: Boolean,
    now: Long = System.currentTimeMillis(),
): NativeSession {
    val bytes = readAtMost(input, MAX_NATIVE_AUTH_RESPONSE_BYTES + 1)
    if (bytes.size > MAX_NATIVE_AUTH_RESPONSE_BYTES) invalidNativeAuthResponse()
    val response = try {
        JSONObject(bytes.toString(Charsets.UTF_8))
    } catch (failure: JSONException) {
        throw NativeAuthFailure(NativeAuthFailureKind.INVALID_RESPONSE, failure)
    }
    return parseNativeSession(response, origin, expectedInstanceId, requireDeviceCredential, now)
}

private fun parseNativeSession(
    response: JSONObject,
    origin: GatewayOrigin,
    expectedInstanceId: String,
    requireDeviceCredential: Boolean,
    now: Long,
): NativeSession {
    if (!INSTANCE_ID_PATTERN.matches(expectedInstanceId)) invalidNativeAuthResponse()
    val expectedKeys = if (requireDeviceCredential) {
        setOf(
            "instanceId",
            "deviceId",
            "deviceToken",
            "deviceExpiresAt",
            "sessionToken",
            "csrfToken",
            "sessionExpiresAt",
        )
    } else {
        setOf("instanceId", "deviceId", "sessionToken", "csrfToken", "sessionExpiresAt")
    }
    val actualKeys = mutableSetOf<String>()
    val keys = response.keys()
    while (keys.hasNext()) actualKeys += keys.next()
    if (actualKeys != expectedKeys) invalidNativeAuthResponse()

    val instanceId = requiredString(response, "instanceId", INSTANCE_ID_PATTERN)
    if (instanceId != expectedInstanceId) invalidNativeAuthResponse()
    val deviceId = requiredString(response, "deviceId", DEVICE_ID_PATTERN)
    val sessionToken = requiredString(response, "sessionToken", OPAQUE_TOKEN_PATTERN)
    val csrfToken = requiredString(response, "csrfToken", OPAQUE_TOKEN_PATTERN)
    val sessionExpiresAt = requiredFutureEpoch(response, "sessionExpiresAt", now)
    val deviceToken = if (requireDeviceCredential) {
        requiredString(response, "deviceToken", OPAQUE_TOKEN_PATTERN)
    } else {
        null
    }
    val deviceExpiresAt = if (requireDeviceCredential) {
        requiredFutureEpoch(response, "deviceExpiresAt", now).also {
            if (it < sessionExpiresAt) invalidNativeAuthResponse()
        }
    } else {
        null
    }
    return NativeSession(
        origin = origin,
        instanceId = instanceId,
        deviceId = deviceId,
        deviceToken = deviceToken,
        deviceExpiresAt = deviceExpiresAt,
        sessionToken = sessionToken,
        csrfToken = csrfToken,
        sessionExpiresAt = sessionExpiresAt,
    )
}

private fun requiredString(response: JSONObject, name: String, pattern: Regex): String {
    val value = response.opt(name) as? String ?: invalidNativeAuthResponse()
    if (!pattern.matches(value)) invalidNativeAuthResponse()
    return value
}

private fun requiredFutureEpoch(response: JSONObject, name: String, now: Long): Long {
    val raw = response.opt(name) as? Number ?: invalidNativeAuthResponse()
    val numeric = raw.toDouble()
    val value = raw.toLong()
    if (!numeric.isFinite() || numeric != value.toDouble() || value <= now) invalidNativeAuthResponse()
    return value
}

private fun invalidNativeAuthResponse(): Nothing =
    throw NativeAuthFailure(NativeAuthFailureKind.INVALID_RESPONSE)

internal fun parseGatewayMetadata(body: JSONObject): GatewayMetadata? {
    val version = body.optInt("version", -1)
    val pluginVersion = body.optString("pluginVersion")
    val minimumApp = body.optString("minimumAndroidAppVersion")
    val protocol = body.optInt("discoveryProtocol", -1)
    if (version < 1 || pluginVersion.length !in 1..64 || minimumApp.length !in 1..64 || protocol < 1) return null
    return GatewayMetadata(version, pluginVersion, minimumApp, protocol)
}

/** Reads no more than [limit] bytes using APIs available on every supported Android version. */
internal fun readAtMost(input: InputStream, limit: Int): ByteArray {
    require(limit >= 0) { "limit must not be negative" }
    if (limit == 0) return byteArrayOf()

    val output = ByteArrayOutputStream(minOf(limit, 8 * 1024))
    val buffer = ByteArray(minOf(limit, 8 * 1024))
    var remaining = limit
    while (remaining > 0) {
        val count = input.read(buffer, 0, minOf(buffer.size, remaining))
        if (count < 0) break
        if (count == 0) {
            val next = input.read()
            if (next < 0) break
            output.write(next)
            remaining -= 1
            continue
        }
        output.write(buffer, 0, count)
        remaining -= count
    }
    return output.toByteArray()
}
