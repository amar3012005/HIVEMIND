use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf, process::{Command, ExitCode}, thread, time::Duration};

#[derive(Debug, Deserialize)]
struct Release { release: String, images: Vec<Image> }
#[derive(Debug, Deserialize)]
struct Image { name: String, digest: String, image: String }

fn main() -> ExitCode {
    match run() { Ok(()) => ExitCode::SUCCESS, Err(error) => { eprintln!("[hm-supervisor] {error}"); ExitCode::FAILURE } }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    let command = args.get(1).map(String::as_str).ok_or("usage: hm-supervisor <install|validate-release|health>")?;
    let root = arg_value(&args, "--root").unwrap_or_else(|| "/opt/hivemind-engine-box".to_string());
    match command {
        "validate-release" => validate_release(PathBuf::from(root).join("release.json")),
        "install" => {
            let release = load_release(PathBuf::from(&root).join("release.json"))?;
            let compose = PathBuf::from(&root).join("compose.yaml");
            if !compose.exists() { return Err("compose.yaml is not installed with this release".into()); }
            render_environment(&root, &release)?;
            compose_command(&root, ["config"])?;
            compose_command(&root, ["pull"])?;
            compose_command(&root, ["up", "--detach", "--remove-orphans"])?;
            wait_for_local_ready(&root)
        }
        "health" => compose_command(&root, ["ps"]),
        _ => Err(format!("unsupported supervisor command: {command}")),
    }
}

fn load_release(path: PathBuf) -> Result<Release, String> {
    let raw = fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let release: Release = serde_json::from_slice(&raw).map_err(|e| format!("invalid release manifest: {e}"))?;
    if release.release.trim().is_empty() || release.images.is_empty() { return Err("release manifest has no release/images".into()); }
    for image in &release.images {
        if !image.digest.starts_with("sha256:") || !image.image.ends_with(&format!("@{}", image.digest)) {
            return Err(format!("{} is not pinned by its declared digest", image.name));
        }
    }
    let digest = format!("{:x}", Sha256::digest(raw));
    println!("[hm-supervisor] release={} manifest_sha256={digest}", release.release);
    Ok(release)
}

fn validate_release(path: PathBuf) -> Result<(), String> { load_release(path).map(|_| ()) }

fn render_environment(root: &str, release: &Release) -> Result<(), String> {
    let expected = [
        ("postgres", "POSTGRES_IMAGE"), ("qdrant", "QDRANT_IMAGE"), ("redis", "REDIS_IMAGE"),
        ("hm-extract", "HM_EXTRACT_IMAGE"), ("hm-playwright", "HM_PLAYWRIGHT_IMAGE"),
        ("hm-model-router", "HM_MODEL_ROUTER_IMAGE"), ("hm-core-engine", "HM_CORE_IMAGE"),
        ("hm-ingestion-worker", "HM_INGESTION_IMAGE"), ("hm-mcp", "HM_MCP_IMAGE"), ("cloudflared", "CLOUDFLARED_IMAGE"),
        ("oauth2-proxy", "OAUTH2_PROXY_IMAGE"), ("caddy", "CADDY_IMAGE"),
    ];
    let mut lines = vec!["POSTGRES_USER=hivemind".to_string(), "ENGINE_BOX_CORE_PORT=8787".to_string()];
    for (name, variable) in expected {
        let image = release.images.iter().find(|candidate| candidate.name == name)
            .ok_or_else(|| format!("release manifest lacks required image: {name}"))?;
        if image.image.contains(['\n', '\r']) { return Err(format!("image reference for {name} is invalid")); }
        lines.push(format!("{variable}={}", image.image));
    }
    let tunnel_token_path = PathBuf::from(root).join("secrets/cloudflare_tunnel_token");
    if let Ok(token) = fs::read_to_string(tunnel_token_path) {
        let token = token.trim();
        if !token.is_empty() {
            if token.contains(['\n', '\r']) { return Err("Cloudflare tunnel credential is malformed".into()); }
            lines.push(format!("CLOUDFLARE_TUNNEL_TOKEN={token}"));
        }
    }
    fs::write(PathBuf::from(root).join(".env"), format!("{}\n", lines.join("\n"))).map_err(|e| format!("cannot write runtime environment: {e}"))?;
    Ok(())
}

fn compose_command<const N: usize>(root: &str, args: [&str; N]) -> Result<(), String> {
    let compose = format!("{root}/compose.yaml");
    let env_file = format!("{root}/.env");
    let mut command = Command::new("docker");
    command.args(["compose", "--env-file", &env_file, "-f", &compose]).args(args);
    run_checked(&mut command)
}

fn wait_for_local_ready(root: &str) -> Result<(), String> {
    let port = fs::read_to_string(format!("{root}/.env")).ok()
        .and_then(|env| env.lines().find_map(|line| line.strip_prefix("ENGINE_BOX_CORE_PORT=")).map(str::to_owned))
        .unwrap_or_else(|| "8787".to_string());
    let url = format!("http://127.0.0.1:{port}/health");
    for _ in 0..30 {
        let status = Command::new("curl").args(["--fail", "--silent", "--max-time", "2", &url]).status();
        if matches!(status, Ok(status) if status.success()) {
            println!("[hm-supervisor] local readiness verified");
            return Ok(());
        }
        thread::sleep(Duration::from_secs(2));
    }
    Err("local Engine Box did not become ready; preserved services and data for repair".into())
}

fn arg_value(args: &[String], name: &str) -> Option<String> { args.iter().position(|arg| arg == name).and_then(|index| args.get(index + 1)).cloned() }
fn run_checked(command: &mut Command) -> Result<(), String> { let status = command.status().map_err(|e| e.to_string())?; if status.success() { Ok(()) } else { Err(format!("command failed: {status}")) } }
