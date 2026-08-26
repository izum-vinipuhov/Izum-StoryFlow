//! OS-keychain storage for the Yandex Books token so it never sits in
//! plaintext inside settings.json. Not compiled on Android: the `keyring`
//! crate has no backend there, and the client falls back to its legacy
//! settings storage on that platform.

use keyring::Entry;

const SERVICE: &str = "com.izum.vinipuhov.storyflow";
const ACCOUNT: &str = "yandex-books-token";

#[tauri::command]
pub fn yandex_token_get() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn yandex_token_set(token: String) -> Result<(), String> {
    Entry::new(SERVICE, ACCOUNT)
        .map_err(|error| error.to_string())?
        .set_password(&token)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn yandex_token_clear() -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(|error| error.to_string())?;
    entry.delete_credential().map_err(|error| error.to_string())
}
