mod auth;
mod config;
mod fsutil;
mod paths;
mod state;
mod timing;
mod watcher;
mod ws;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::State;
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use fsremote_protocol::{LoginRequest, LoginResponse};
use serde::Serialize;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;
use crate::timing::TimingLog;

#[derive(Serialize)]
struct Health {
    ok: bool,
}

/// Public metadata for each configured root (paths are not exposed).
#[derive(Serialize)]
struct RootInfo {
    id: String,
    label: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "hash-password" {
        let pw = args.get(2).map(|s| s.as_str()).unwrap_or("admin");
        let hash = bcrypt::hash(pw, bcrypt::DEFAULT_COST)?;
        println!("{hash}");
        return Ok(());
    }

    let config_path = std::env::var("FSREMOTE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("config.toml"));

    let config = Arc::new(Config::load(&config_path)?);
    let roots = config.resolve_roots()?;

    let log_file = tracing_appender::rolling::never(
        config
            .log_path
            .parent()
            .unwrap_or(std::path::Path::new(".")),
        config
            .log_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("fsremote.log"),
    );

    let (non_blocking, _log_guard) = tracing_appender::non_blocking(log_file);
    let filter = EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into());
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout).with_filter(filter.clone()))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_filter(filter),
        )
        .init();

    let (broadcast_tx, _keep) = tokio::sync::broadcast::channel::<fsremote_protocol::ServerMessage>(
        256,
    );

    let watchers = watcher::spawn_root_watchers(&roots, broadcast_tx.clone())?;

    let timing_path = config.timing_log_path_resolved();
    let timing_log = match TimingLog::create(&timing_path) {
        Ok(t) => {
            tracing::info!(path = %timing_path.display(), "timing log");
            Some(std::sync::Arc::new(t))
        }
        Err(e) => {
            tracing::warn!(path = %timing_path.display(), error = %e, "could not open timing log; timing disabled");
            None
        }
    };

    let state = Arc::new(AppState {
        config: config.clone(),
        roots,
        broadcast_tx: broadcast_tx.clone(),
        _watchers: watchers,
        timing_log,
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/roots", get(list_roots))
        .route("/api/login", post(login))
        .route("/ws", get(ws_upgrade))
        .with_state(state.clone())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http());

    let addr = config.bind.parse::<std::net::SocketAddr>()?;
    tracing::info!(?addr, "listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<Health> {
    Json(Health { ok: true })
}

async fn list_roots(State(state): State<Arc<AppState>>) -> Json<Vec<RootInfo>> {
    let start = Instant::now();
    let roots: Vec<RootInfo> = state
        .config
        .roots
        .iter()
        .map(|r| RootInfo {
            id: r.id.clone(),
            label: r.label.clone(),
        })
        .collect();
    if let Some(log) = &state.timing_log {
        log.record("http", "GET /api/roots", "", start.elapsed(), true);
    }
    Json(roots)
}

async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, (axum::http::StatusCode, String)> {
    let start = Instant::now();
    let username = req.username.clone();
    let result = login_inner(&state, req).await;
    if let Some(log) = &state.timing_log {
        log.record(
            "http",
            "POST /api/login",
            &format!("user={username}"),
            start.elapsed(),
            result.is_ok(),
        );
    }
    result
}

async fn login_inner(
    state: &Arc<AppState>,
    req: LoginRequest,
) -> Result<Json<LoginResponse>, (axum::http::StatusCode, String)> {
    let user = state
        .config
        .users
        .iter()
        .find(|u| u.username == req.username);
    let Some(u) = user else {
        return Err((axum::http::StatusCode::UNAUTHORIZED, "bad credentials".into()));
    };
    if !auth::verify_password(&u.password_hash, &req.password) {
        return Err((axum::http::StatusCode::UNAUTHORIZED, "bad credentials".into()));
    }
    let token = auth::sign_jwt(
        &state.config.jwt_secret,
        &u.username,
        state.config.jwt_exp_secs,
    )
    .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(LoginResponse {
        token,
        expires_in_secs: state.config.jwt_exp_secs,
    }))
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| ws::handle_socket(socket, state))
}
