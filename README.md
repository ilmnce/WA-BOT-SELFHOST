# Ariel Engine — WhatsApp Business Automation

Bot WhatsApp untuk membalas chat prospek Pesona Kahuripan secara otomatis, menjaga konteks percakapan, dan mengirim brosur, video, atau lokasi sesuai permintaan prospek. Dashboard lokal menampilkan status koneksi, jumlah pesan, dan log percakapan terbaru.

Dashboard menggunakan pola inbox seperti WhatsApp: daftar prospek di kiri, riwayat satu nomor di tengah, dan detail prospek di kanan. Percakapan disimpan terpisah per nomor di `data/conversations.json`, sehingga tidak bercampur dan dapat dipulihkan setelah aplikasi restart.

## Persiapan

- Node.js 18 atau lebih baru
- Google Chrome
- Nomor WhatsApp Business yang akan digunakan bot
- Minimal satu API key provider: Gemini, NVIDIA NIM, DeepSeek, atau Groq

## Menjalankan

1. Salin `.env.example` menjadi `.env`.
2. Isi API key dan sesuaikan jam operasional.
3. Jalankan `npm install`.
4. Jalankan `npm start`.
5. Buka `http://127.0.0.1:3000`, lalu scan QR WhatsApp bila diminta.

Untuk pengembangan gunakan `npm run dev`. Jalankan `npm run check` sebelum perubahan dipakai untuk memastikan sintaks dan pemeriksaan otomatis lolos.

Gunakan `npm run preview` untuk melihat dashboard dengan data contoh tanpa menghubungkan akun WhatsApp atau mengirim pesan sungguhan.

## Pengelolaan inbox

- Cari prospek berdasarkan nama, nomor, atau proyek.
- Filter chat yang belum dibaca atau sedang ditangani sales.
- Pause auto-reply untuk satu nomor ketika sales mengambil alih percakapan.
- Balas manual dari panel percakapan tanpa mematikan bot global.
- Tandai tahap prospek: baru, qualified, survei, booking, follow-up, atau selesai.
- Proyek yang disebut prospek atau media yang dikirim akan terdeteksi otomatis.
- ID internal WhatsApp (`@lid`) dipetakan ke nomor asli dan ditampilkan dalam format lokal `08…` jika WhatsApp menyediakan pemetaannya.

## Konfigurasi penting

| Variabel | Default | Kegunaan |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Alamat dashboard. Default hanya dapat diakses dari komputer bot. |
| `PORT` | `3000` | Port dashboard. |
| `DASHBOARD_TOKEN` | kosong | Kata sandi dashboard. Wajib jika `HOST` dibuka ke jaringan. Username dapat diisi bebas. |
| `NVIDIA_API_KEY` | kosong | API key NVIDIA NIM untuk fallback model `openai/gpt-oss-120b`. |
| `NVIDIA_BASE_URL` | NVIDIA NIM | Endpoint OpenAI-compatible NVIDIA. |
| `NVIDIA_MODEL` | `openai/gpt-oss-120b` | Model NVIDIA yang digunakan. |
| `OPERATING_TIMEZONE` | `Asia/Jakarta` | Zona waktu jam kerja. |
| `OPERATING_START_HOUR` | `8` | Jam mulai membalas otomatis. |
| `OPERATING_END_HOUR` | `24` | Jam berhenti membalas otomatis. Mendukung rentang melewati tengah malam. |
| `MESSAGE_DEBOUNCE_MS` | `6000` | Waktu menunggu pesan beruntun sebelum diproses sebagai satu konteks. |
| `FILTER_SAVED_CONTACTS` | `true` | Jika aktif, bot hanya membalas nomor yang belum tersimpan. |
| `BOT_ACTIVE_AT_STARTUP` | `true` | Status balasan otomatis saat aplikasi dimulai. |
| `HISTORY_TTL_HOURS` | `24` | Lama konteks prospek disimpan di memori. |

Jika dashboard perlu diakses dari perangkat lain, gunakan `HOST=0.0.0.0` dan isi `DASHBOARD_TOKEN` dengan kata sandi yang kuat. Jangan meneruskan port dashboard langsung ke internet; gunakan jaringan privat atau reverse proxy HTTPS.

## Media proyek

File media berada di folder `media/`. Nama file harus mengikuti pola yang sudah digunakan, misalnya `PL_PK18.jpg`, `video_pk18.mp4`, dan `mapspk18.txt`. Bot hanya mengirim media ketika prospek meminta dan membatasi pengiriman ulang untuk mencegah spam.

## Catatan operasional

- Sesi WhatsApp disimpan di `.wwebjs_auth/` dan tidak boleh dimasukkan ke Git.
- API key hanya disimpan di `.env`; jangan menaruh token asli di `.env.example`.
- Endpoint `GET /health` dapat digunakan untuk pemeriksaan sederhana tanpa membuka isi chat atau QR.
- Integrasi ini memakai WhatsApp Web. Perubahan dari WhatsApp dapat memengaruhi koneksi, jadi pantau dashboard setelah pembaruan dependensi.
