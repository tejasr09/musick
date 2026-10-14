FROM nginx:stable-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html styles.css app.js m4a-playback.js m4a-aac-worker.js m4a-alac-worker.js supabase-config.js youtube-config.example.json /usr/share/nginx/html/
COPY codec/Cargo.toml codec/Cargo.lock /usr/share/nginx/html/codec/
COPY codec/src/ /usr/share/nginx/html/codec/src/
COPY vendor/ /usr/share/nginx/html/vendor/
