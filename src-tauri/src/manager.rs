fn main() {
    if let Err(error) = workfit_lib::run_manager() {
        eprintln!("WorkFit Manager failed to start: {error}");
        std::process::exit(1);
    }
}
