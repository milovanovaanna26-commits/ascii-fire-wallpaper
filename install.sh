#!/usr/bin/env bash
set -euo pipefail

UUID="ascii-fire@local"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp "$SRC"/extension.js "$SRC"/fire.js "$SRC"/metadata.json "$DEST"/
echo "Скопировано в $DEST"

gsettings set org.gnome.desktop.background picture-options 'none'
gsettings set org.gnome.desktop.background picture-uri ''
gsettings set org.gnome.desktop.background picture-uri-dark ''
gsettings set org.gnome.desktop.background primary-color '#16161d'
echo "Тёмные обои #16161d установлены"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID"
    echo "Расширение включено."
    echo "После правок кода на Wayland нужен перелогин, чтобы Shell перечитал файлы."
else
    # Wayland GNOME Shell only scans for new extensions at login.
    gsettings set org.gnome.shell enabled-extensions \
        "$(python3 -c "import ast,sys; l=ast.literal_eval(sys.argv[1] if sys.argv[1]!='@as []' else '[]'); u=sys.argv[2]; print(str(l+[u] if u not in l else l))" \
           "$(gsettings get org.gnome.shell enabled-extensions)" "$UUID")"
    echo "Shell ещё не видит расширение: на Wayland нужно выйти из сеанса и войти снова."
    echo "Оно уже добавлено в enabled-extensions и включится само после входа."
fi
