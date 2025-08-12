function clearMessages() {
  document.getElementById('login-hata').innerText = '';
  document.getElementById('kayit-hata').innerText = '';
}

// GİRİŞ
function login() {
  clearMessages();
  const rol = document.getElementById('login-role')?.value || 'ogrenci';
  const kadi = document.getElementById('login-kadi').value.trim();
  const sifre = document.getElementById('login-sifre').value.trim();

  if (!kadi || !sifre) {
    document.getElementById('login-hata').innerText = 'Lütfen kullanıcı adı ve şifre gir.';
    return;
  }

  if (rol === 'ogretmen') {
    if (kadi === "Sindeltahir" && sifre === "Tahir1453") {
      alert('Hoş geldin öğretmenim! Admin paneline yönlendiriliyorsun...');
      localStorage.setItem('girisYapan', JSON.stringify({ kadi, role: 'admin' }));
      window.location.href = "admin-panel.html";
    } else {
      document.getElementById('login-hata').innerText = "Hatalı kullanıcı adı veya şifre!";
    }
    return;
  }

  // Öğrenci girişi
  let ogrenciler = JSON.parse(localStorage.getItem('ogrenciler') || '[]');
  const kullanici = ogrenciler.find(o => o.kadi.toLowerCase() === kadi.toLowerCase() && o.sifre === sifre);

  if (kullanici) {
    alert(`Hoş geldin ${kullanici.kadi}! Anasayfaya yönlendiriliyorsun...`);
    localStorage.setItem('girisYapan', JSON.stringify({
      kadi: kullanici.kadi,
      role: 'ogrenci',
      puan: kullanici.puan || 0,
      sinif: kullanici.sinif || ''
    }));
    window.location.href = 'Anasayfa.html';
  } else {
    document.getElementById('login-hata').innerText = 'Kullanıcı adı veya şifre yanlış.';
  }
}

// KAYIT
function register() {
  clearMessages();
  const kadi = document.getElementById('kayit-kadi').value.trim();
  const sifre = document.getElementById('kayit-sifre').value.trim();
  const sinif = document.getElementById('kayit-sinif').value;

  if (!kadi || !sifre || !sinif) {
    document.getElementById('kayit-hata').innerText = 'Tüm alanları doldurun.';
    return;
  }

  let ogrenciler = JSON.parse(localStorage.getItem('ogrenciler') || '[]');

  if (ogrenciler.some(o => o.kadi.toLowerCase() === kadi.toLowerCase())) {
    document.getElementById('kayit-hata').innerText = 'Bu kullanıcı adı zaten kayıtlı.';
    return;
  }

  ogrenciler.push({ kadi, sifre, sinif, puan: 0 });
  localStorage.setItem('ogrenciler', JSON.stringify(ogrenciler));

  alert('Kayıt başarılı! Şimdi giriş yapabilirsin.');
  document.getElementById('kayit-kadi').value = '';
  document.getElementById('kayit-sifre').value = '';
  document.getElementById('kayit-sinif').value = '';
}