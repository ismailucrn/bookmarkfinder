# Doğrulama

Bu rapor yerel MVP'nin doğrulama sınırlarını açıklar. Node.js v26.8.1, SQLite 3.53.4 ile çalıştırıldı. Proje Node >=24 gerektirir; başka Node sürümünde ayrıca çalıştırılmadı.

## Çalıştırılan kontroller

- `npm test`: **65/65 geçti**, atlanan test yok.
- `npm run check`: CLI, server ve orchestrator sözdizimi geçti.
- `npm run demo`: 5 açık örnek kayıt içinden “PDF tablo çıkarma Python” sorgusu pdfplumber kaydını ilk sıraya getirdi. Mod `lexical` + `retrieval`; sahte Jev/semantic puanı yok.

## Test kapsamı

| Alan | Kapsam |
| --- | --- |
| Ingestion | 26 test: GitHub/X sayfalama, sınırlı okuma, dış hosta yönlendirmeme, kısmi snapshot, iptal, bozuk/büyük yanıtlar, token temizliği, X güncel/legacy alan uyumu, GitHub pagination drift |
| Search | 19 test: BM25, Türkçe normalizasyonu, C++/C#/C ayrımı, embedding cache ve batch, cosine/RRF, boyut/şema bozukluğu, büyük yanıtlar, görünür fallback |
| Jev | 10 test: resmî Score şeması, puan ile confidence ayrımı, kararlı sıralama, kısmi hata fallback, timeout, concurrency, yanıt boyutu sınırı |
| Entegrasyon | 10 test: tam pipeline, gerçek SQLite kalıcılığı, kullanıcı izolasyonu, atomic snapshot, dedup/seri yazmalar, iş kurtarma, gerçek loopback HTTP, Origin/Host/kimlik korumaları, mock embedding+Jev bileşimi |

Harici sağlayıcılar bu testlerde gerçek model çalıştırmaz. Türkçe bir sorgunun İngilizce belgeyi bulduğu embedding entegrasyon testi kontrollü vektörlerle veri akışını doğrular; model kalitesini ölçmez. Gerçek modelin aynı sonucu vereceğine kanıt değildir.

## Henüz doğrulanmayanlar

- Gerçek GitHub/X hesaplarının token/izin/erişim ve ücretlendirmesi.
- Canlı Jev modeliyle uygunluk doğruluğu, kalibrasyon, gecikme ve maliyet.
- Seçilecek embedding modelinin Türkçe–İngilizce retrieval başarısı.
- Büyük arşiv, üretim yükü, çok kullanıcılı SaaS veya uzak hosting.
- OAuth hesap bağlama/token yenileme ve web arayüzü (bu sürümde uygulanmadı).

Bu kontroller için anahtarlar yerel .env içinde yapılandırılır. Bir dizi gerçek sorgu ve beklenen kayıtla Recall@5 / MRR, Jev açık-kapalı kıyası, p50/p95 gecikme ve gerçek provider usage maliyeti ölçülmeli.


## 15 Ekim 2026 — klasör ve ortam düzenlemesi

- Kaynaklar tek ana `recall/` klasöründe tutuldu; önceki ZIP de `dist/` altına alındı.
- `.env` özel `0600` izinle oluşturuldu; `.venv` yerel Python ile paket indirmeden oluşturuldu. Uygulama Node tabanlı kalır; Python ortamı paketleme aracını çalıştırır.
- `npm run setup` iki kez başarılı; inode/zaman/izin kontrolü tekrar çalıştırmanın mevcut ortamları koruduğunu doğruladı, anahtar değerleri okunmadı.
- `npm run package`, sentetik ortam/sır/veritabanı/symlink dışlama kontrolleri ve ZIP bütünlüğü kontrolü başarılı.
- Ortam düzenlemesinden sonra `npm test` **65/65**, `npm run check`, `npm run demo` yeniden başarılı.
- Bu turdaki iki geliştirme subagentı açık `gpt-6.1-sol` ve `high` ile başlatıldı. `.codex/config.toml` ve dört özel rol dosyasında yeni oturumlar için aynı varsayılanlar yer alıyor. Aktif ana sohbetin modeli geriye dönük değiştirilmiş sayılmaz.
- Proje klasöründeki kurulum ve paketleme adımları yerel ortamda doğrulandı.


## Kullanıcının seçtiği proje köküne taşıma

Kaynaklar ana proje klasörü altında doğrulandı. `.env` içerikleri gösterilmeden korundu, `.codex` model ayarları doğrulandı, `.venv` yeni konumda oluşturuldu. Eski demo servisi durduruldu; SQLite backup API ile aktarılan veritabanının integrity_check sonucu `ok`. Yeni konumda tüm 65 test ve check/demo/paketleme kontrolleri geçti. Bu taşıma canlı API doğrulaması değildir.


## Public repository preparation

The project uses the descriptive name Bookmark Finder. Personal local paths were removed from tracked documentation, local secrets/data/environments and archives were verified excluded from Git, and an explicit source allowlist was reviewed before staging. After the user-facing naming changes, all 65 tests, check, demo and packaging checks passed. External-provider behavior remains mocked in the test suite. Repository: https://github.com/ismailucrn/bookmarkfinder.
