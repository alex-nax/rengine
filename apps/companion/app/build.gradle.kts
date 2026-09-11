plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.rengine.companion"
    compileSdk = 35
    // Pinned side by side with the Gradle wrapper: init.sh checks both are installed and instructs,
    // and nothing here downloads an SDK (spec 128, "no hidden downloads").
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "com.rengine.companion"
        // API 29 covers Horizon OS (the Quest 3 on hand reports 34) and every phone this targets.
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        ndk {
            // arm64 only: every device this app targets is arm64, and a second ABI doubles the
            // native build for nothing until one exists.
            abiFilters += "arm64-v8a"
        }
    }

    externalNativeBuild {
        cmake {
            // The app's own CMake, which reaches UP into this repository for the shared C modules
            // rather than holding copies of them (F144 criterion 1).
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
}
