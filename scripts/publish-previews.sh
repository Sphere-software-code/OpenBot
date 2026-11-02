#!/usr/bin/env bash
# Copies every Bot-built site (sites/<slug>/dist in a Bot's workspace volume) into the site-builder's
# projects folder, so it shows at https://preview.sphere-software.com/<slug>/ within a minute.
#
# Only folders this script created (marked with .openbot-preview) are ever overwritten; a slug that
# belongs to a site-builder project is skipped and named, so the two never clobber each other.
# Run from cron every minute. `--once <volume> <slug>` publishes one site and prints its URL.
set -u
VOLUMES_ROOT=/var/lib/docker/volumes
PROJECTS=/opt/sphere-site-builder/projects
PUBLIC=https://preview.sphere-software.com
MARK=.openbot-preview

publish() {
  local src="$1" slug="$2" dest="$PROJECTS/$slug"
  [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || { echo "skip $slug: not a valid slug"; return; }
  [ -f "$src/index.html" ] || return 0
  if [ -d "$dest" ] && [ ! -f "$dest/$MARK" ]; then
    echo "skip $slug: $dest belongs to the site builder"; return
  fi
  mkdir -p "$dest/dist"
  touch "$dest/$MARK"
  if rsync -a --delete --chmod=D755,F644 "$src/" "$dest/dist/"; then
    echo "published $slug -> $PUBLIC/$slug/"
  else
    echo "failed $slug"
  fi
}

if [ "${1:-}" = "--once" ]; then
  publish "$VOLUMES_ROOT/$2/_data/sites/$3/dist" "$3"; exit
fi

for vol in "$VOLUMES_ROOT"/openbot-workspace-*; do
  [ -d "$vol/_data/sites" ] || continue
  for site in "$vol/_data/sites"/*/; do
    slug="$(basename "$site")"
    dest="$PROJECTS/$slug"
    # Changed since last publish? Compare newest file in dist against the marker.
    if [ -f "$dest/$MARK" ] && [ -z "$(find "$site/dist" -newer "$dest/$MARK" -print -quit 2>/dev/null)" ]; then
      continue
    fi
    publish "$site/dist" "$slug"
  done
done
