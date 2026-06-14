pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ExpenseReport"

// Composite build: pulls in the pure-Kotlin logic from ../core as the
// "com.expensereport:core" dependency. The SAME code that is unit-tested standalone
// is what ships in the app — no duplication, no drift.
includeBuild("../core")

include(":app")
