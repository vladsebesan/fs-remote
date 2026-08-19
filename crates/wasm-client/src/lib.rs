//! WASM bindings (minimal stub). The web UI currently implements the wire protocol in TypeScript
//! inside the worker; this crate can be expanded to share more logic via wasm-bindgen.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn fsremote_wasm_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub use fsremote_protocol::{
    decode_download_chunk, decode_upload_chunk, encode_download_chunk, encode_upload_chunk,
};
