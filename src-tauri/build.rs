fn main() {
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // Development binaries and tests run outside a .app bundle.
        if std::env::var("PROFILE").as_deref() == Ok("debug") {
            println!(
                "cargo:rustc-link-arg=-Wl,-rpath,{}",
                std::env::var("CARGO_MANIFEST_DIR").unwrap()
            );
        }
    }
    tauri_build::build()
}
