use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

pub fn sign_jwt(secret: &str, subject: &str, exp_secs: u64) -> anyhow::Result<String> {
    let exp = chrono_now() + exp_secs as usize;
    let claims = Claims {
        sub: subject.to_string(),
        exp,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;
    Ok(token)
}

pub fn verify_jwt(secret: &str, token: &str) -> anyhow::Result<Claims> {
    let mut val = Validation::default();
    val.validate_exp = true;
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &val,
    )?;
    Ok(data.claims)
}

fn chrono_now() -> usize {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as usize
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}
