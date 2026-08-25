"""Авторизация в аккаунте Яндекс (Bookmate) и сохранение токена.

Автор скрипта: kettle017/RU_Bookmate_downloader
https://github.com/kettle017/RU_Bookmate_downloader

Этот скрипт модифицирован для Izum StoryFlow.

Запустите `python get_token.py` — откроется окно входа в Яндекс. После входа
access_token сохранится в `token.txt` рядом со скриптом, откуда его читают и
консольная версия (`RUBookmatedownloader.py`), и графический интерфейс
(`ui.py`).
"""
import os
import sys
import urllib.parse

OAUTH_URL = (
    "https://oauth.yandex.ru/authorize?response_type=token"
    "&client_id=4483e97bab6e486a9822973109a14d05"
)
REDIRECT_HOST = "yx4483e97bab6e486a9822973109a14d05.oauth.yandex.ru"
TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "token.txt")


def get_yandex_token():
    """Открывает окно входа в Яндекс и возвращает access_token.

    Возвращает None, если окно закрыли, не дойдя до входа.
    """
    import webview

    def on_loaded(window):
        url = window.get_current_url()
        if REDIRECT_HOST not in urllib.parse.urlparse(url).netloc:
            return
        token = urllib.parse.parse_qs(urllib.parse.urlparse(url).fragment).get(
            "access_token", [None])[0]
        if token:
            window.auth_token = token
            window.destroy()

    window = webview.create_window("Вход в аккаунт Яндекс", OAUTH_URL)
    window.events.loaded += on_loaded
    window.auth_token = None
    webview.start()
    return window.auth_token


def main():
    token = get_yandex_token()
    if not token:
        sys.exit("Не удалось получить токен: окно входа было закрыто.")
    with open(TOKEN_FILE, "w", encoding="utf-8") as file:
        file.write(token)
    print(f"Токен сохранён в {TOKEN_FILE}")


if __name__ == "__main__":
    main()
