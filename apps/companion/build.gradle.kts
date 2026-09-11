// Every version is pinned here and nowhere else, so a reader sees the whole toolchain in one place
// and `init.sh` can check the halves that live outside Gradle (the SDK, the NDK).
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
