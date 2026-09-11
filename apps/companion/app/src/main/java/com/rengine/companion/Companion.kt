package com.rengine.companion

/**
 * The Kotlin side of the companion (spec 128, decision 7).
 *
 * It is deliberately thin. The C layer drives the frame loop through [android.app.NativeActivity],
 * exactly as `app.c` does on the desktop, and Rust serves it through the C ABI; Kotlin is here for
 * the things only the platform can do — the QR scan F142 needs, notification permission, and the
 * lifecycle callbacks Android will only deliver to a JVM object.
 *
 * Nothing calls this yet. It exists so the shell has a home before it has a job, and so the build
 * is a real Kotlin application rather than a native library wearing an APK.
 */
object Companion {
    /** Mirrors red-core's PROTOCOL_VERSION; the façade refuses a peer that does not match. */
    const val PROTOCOL: String = "/red/1"
}
