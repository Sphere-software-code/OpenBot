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

# Where a workspace keeps its sites. Before upstream #871 a Bot's volume held them at its root
# (openbot-workspace-<bot>/_data/sites). Since then a computer runs with COMPUTER_SEPARATE_WORKSPACES=on
# and each Bot's files sit in their own folder (openbot-workspace-bot-<bot>/_data/computers/<bot>/sites),
# so both layouts are searched.
sites_dirs() {
  local vol="$1"
  [ -d "$vol/_data/sites" ] && echo "$vol/_data/sites"
  for d in "$vol/_data/computers"/*/sites; do [ -d "$d" ] && echo "$d"; done
  return 0
}

if [ "${1:-}" = "--once" ]; then
  for dir in $(sites_dirs "$VOLUMES_ROOT/$2"); do
    [ -d "$dir/$3/dist" ] && { publish "$dir/$3/dist" "$3"; exit; }
  done
  echo "no site $3 in volume $2"; exit 1
fi

for vol in "$VOLUMES_ROOT"/openbot-workspace-*; do
 for sites in $(sites_dirs "$vol"); do
  for site in "$sites"/*/; do
    slug="$(basename "$site")"
    dest="$PROJECTS/$slug"
    # Changed since last publish? Compare newest file in dist against the marker.
    if [ -f "$dest/$MARK" ] && [ -z "$(find "$site/dist" -newer "$dest/$MARK" -print -quit 2>/dev/null)" ]; then
      continue
    fi
    publish "$site/dist" "$slug"
  done
 done
done
