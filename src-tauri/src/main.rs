#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = workfit_lib::run() {
        eprintln!("WorkFit exited with an error: {error}");
        std::process::exit(1);
    }
}
