(function () {
  "use strict";

  const DEFAULT_FILENAME = "gameResources.json";
  const TIERS = ["UHD", "HD", "SD"];

  function formatSize(bytes) {
    if (bytes >= 1000 * 1024 * 1024) return (bytes / 1024 ** 3).toFixed(2) + " GB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  function formatSizeBoth(bytes) {
    const mb = bytes / 1024 / 1024;
    const gb = bytes / 1024 ** 3;
    return `${mb.toFixed(0)} MB (${gb.toFixed(2)} GB)`;
  }

  function fileName(p) { return p.split(/[\\\/]/).pop(); }

  function pakNumber(p) {
    const m = fileName(p).match(/pakchunk(\d+)/i);
    return m ? m[1] : null;
  }

  function patchTitle(n) {
    const b = n.replace(/\.krpdiff$/i, "");
    const p = b.split("_");
    if (p.length >= 4 && p[2] === "group") return `Patch Update ${p[0]}_${p[1]} group ${p[3]}`;
    return "Patch Update " + n;
  }

  function detectTier(dest) {
    const m = fileName(dest).match(/-(UHD|HD|SD)-WindowsNoEditor\.pak$/i);
    return m ? m[1].toUpperCase() : null;
  }

  class WuwaViewer {
    constructor(root, content) {
      this.root    = root;
      this.content = content;

      const listEl = root.querySelector('script[data-role="version-list"]');
      if (!listEl) {
        console.warn('[wuwa-viewer] <script data-role="version-list"> tidak ditemukan.');
        return;
      }

      let raw;
      try {
        raw = JSON.parse(listEl.textContent);
      } catch (e) {
        console.error("[wuwa-viewer] Gagal parse version-list:", e);
        return;
      }

      if (!Array.isArray(raw) || raw.length === 0) {
        console.warn("[wuwa-viewer] version-list kosong.");
        return;
      }

      this.versions = raw.map(v => this.normalizeCfg(v));
      this.cfg      = this.versions[0];

      this.$drop               = root.querySelector("#dropZone");
      this.$input              = root.querySelector("#fileInput");
      this.$browse             = root.querySelector("#browseBtn");
      this.$fileLabel          = root.querySelector("#dropZoneFileLabel");
      this.$process            = root.querySelector("#processBtn");
      this.$versionSection     = root.querySelector("#versionSection");
      this.$versionGroup       = root.querySelector("#versionRadioGroup");
      this.$uploadSection      = root.querySelector("#uploadSection");
      this.$postProcessSection = root.querySelector("#postProcessSection");
      this.$refreshBtn         = root.querySelector("#refreshBtn");
      this.$defaultBtn         = root.querySelector("#defaultBtn");

      if (!this.$drop || !this.$input || !this.$browse || !this.$process
          || !this.$uploadSection || !this.$postProcessSection
          || !this.$refreshBtn || !this.$defaultBtn) {
        console.warn("[wuwa-viewer] Elemen HTML wajib tidak ditemukan.");
        return;
      }

      this.ef2Content        = "";
      this.abortCtrl         = null;
      this.isLoading         = false;
      this.currentVersionIdx = 0;
      this.lastProcessMode   = null;

      this.buildVersionRadios();
      this.bind();
    }

    normalizeCfg(v) {
      return {
        label:           v.label || ("v" + (v.version || "")),
        fromLabel:       v.fromLabel || "",
        version:         v.version || "",
        chunkVersion:    v.chunkVersion || v.version || "",
        resourceVersion: v.resourceVersion || "3.6.1",
        base:            v.base || "",
        hash:            v.hash || "",
        jsonUrl:         v.jsonUrl || "",
        allowedFilename: v.allowedFilename || DEFAULT_FILENAME,
      };
    }

    buildVersionRadios() {
      if (!this.$versionGroup) return;

      if (this.versions.length <= 1) {
        if (this.$versionSection) this.$versionSection.style.display = "none";
        return;
      }

      const frag = document.createDocumentFragment();

      this.versions.forEach((cfg, idx) => {
        const label = document.createElement("label");
        label.className = "high-contrast";

        const input = document.createElement("input");
        input.type  = "radio";
        input.name  = "gameVersion";
        input.value = String(idx);
        if (idx === 0) input.checked = true;

        const span = document.createElement("span");
        span.className = "design-box";
        span.textContent = cfg.label;

        label.appendChild(input);
        label.appendChild(span);
        frag.appendChild(label);

        input.addEventListener("change", () => {
          if (this.abortCtrl) {
            this.abortCtrl.abort();
            this.abortCtrl = null;
          }
          this.isLoading = false;

          this.currentVersionIdx = idx;
          this.cfg = this.versions[idx];
          this.showUploadForm();
        }, { passive: true });
      });

      this.$versionGroup.replaceChildren(frag);
    }

    showUploadForm() {
      this.$uploadSection.hidden = false;
      this.$postProcessSection.hidden = true;
      this.$input.value = "";
      this.$fileLabel.textContent = "Belum ada file dipilih";
      this.resetContent();
    }

    showPostProcess() {
      this.$uploadSection.hidden = true;
      this.$postProcessSection.hidden = false;
    }

    resetContent() {
      this.content.replaceChildren();
      this.ef2Content = "";
      this.lastProcessMode = null;
    }

    urlKrpdiff() {
      const c = this.cfg;
      return `https://${c.base}/launcher/game/G153/50004/${c.version}/${c.hash}/resource/50004/${c.version}/${c.resourceVersion}/resources/`;
    }
    urlPak() {
      const c = this.cfg;
      return `https://${c.base}/launcher/game/G153/50004/${c.chunkVersion}/${c.hash}/zip/Client/Content/Paks/`;
    }
    urlHd() {
      const c = this.cfg;
      return `https://${c.base}/launcher/game/G153/50004/${c.chunkVersion}/${c.hash}/zip/Client/Content/HD/`;
    }
    urlZip() {
      const c = this.cfg;
      return `https://${c.base}/launcher/game/G153/50004/${c.chunkVersion}/${c.hash}/zip/`;
    }

    getFullUrl(dest) {
      let p = dest.replace(/^[\/\\]+/, "");
      const lower = p.toLowerCase();

      if (lower.startsWith("client/content/hd/") || lower.startsWith("content/hd/")) {
        p = p.replace(/^client[\/\\]content[\/\\]hd[\/\\]*/i, "");
        p = p.replace(/^content[\/\\]hd[\/\\]*/i, "");
        return this.urlHd() + p;
      }

      if (p.startsWith("Client/Content/Paks/") || p.startsWith("Content/Paks/")) {
        p = p.replace(/^Client[\/\\]Content[\/\\]Paks[\/\\]*/i, "");
        p = p.replace(/^Content[\/\\]Paks[\/\\]*/i, "");
      }
      if (p.endsWith("-WindowsNoEditor.pak")) return this.urlPak() + p;

      if (/\.exe$/i.test(p)) return this.urlZip() + p.replace(/\\/g, "/");

      return this.urlKrpdiff() + p;
    }

    bind() {
      this.$browse.onclick = (e) => { e.stopPropagation(); this.$input.click(); };

      this.$input.onchange = () => {
        if (this.$input.files.length) this.validate(this.$input.files[0]);
      };

      ["dragenter", "dragover", "dragleave", "drop"].forEach(ev =>
        this.$drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); })
      );
      ["dragenter", "dragover"].forEach(ev =>
        this.$drop.addEventListener(ev, () => this.$drop.classList.add("drop-zone--active"), { passive: true })
      );
      ["dragleave", "drop"].forEach(ev =>
        this.$drop.addEventListener(ev, () => this.$drop.classList.remove("drop-zone--active"), { passive: true })
      );

      this.$drop.ondrop = e => {
        const files = e.dataTransfer.files;
        if (files.length) {
          this.$input.files = files;
          this.validate(files[0]);
        }
      };

      this.$drop.onclick = e => {
        if (e.target !== this.$browse) this.$input.click();
      };

      this.$process.onclick    = () => this.process();
      this.$refreshBtn.onclick = () => this.showUploadForm();
      this.$defaultBtn.onclick = () => this.fetchDefault();

      this.content.onclick = e => {
        const s = e.target.closest(".wuwa-dl");
        const b = e.target.closest(".batch-dl");
        if (s && s.dataset.url) window.open(s.dataset.url, "_blank");
        if (b && this.ef2Content) this.downloadEf2(this.ef2Content, b.dataset.file);
      };
    }

    validate(file) {
      if (!file || file.name !== this.cfg.allowedFilename) {
        alert(`File harus bernama "${this.cfg.allowedFilename}"`);
        this.$input.value = "";
        this.$fileLabel.textContent = "Belum ada file dipilih";
        return false;
      }
      this.$fileLabel.textContent = file.name;
      return true;
    }

    process() {
      const file = this.$input.files[0];
      if (file) {
        this.processLocal(file);
      } else {
        if (this.isLoading) return;
        this.processRemote();
      }
    }

    processLocal(file) {
      if (this.abortCtrl) {
        this.abortCtrl.abort();
        this.abortCtrl = null;
      }
      this.isLoading = false;
      this.$process.disabled = false;

      const r = new FileReader();
      r.onload = e => {
        try {
          this.lastProcessMode = "local";
          this.render(JSON.parse(e.target.result));
          this.showPostProcess();
        } catch (err) {
          alert("Error JSON (lokal): " + err.message);
        }
      };
      r.readAsText(file);
    }

    processRemote() {
      if (!this.cfg.jsonUrl) {
        alert("Tidak ada file diupload dan tidak ada URL JSON default.");
        return;
      }

      if (this.abortCtrl) this.abortCtrl.abort();
      this.abortCtrl = new AbortController();
      this.isLoading = true;
      this.$process.disabled = true;

      const signal      = this.abortCtrl.signal;
      const snapshotCfg = this.cfg;

      fetch(snapshotCfg.jsonUrl, { cache: "no-cache", signal })
        .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(j => {
          if (this.cfg !== snapshotCfg) return;
          try {
            this.lastProcessMode = "remote";
            this.render(j);
            this.showPostProcess();
          } catch (err) {
            alert("Error JSON (remote): " + err.message);
          }
        })
        .catch(err => {
          if (err.name === "AbortError") return;
          alert("Data tidak tersedia, silakan upload file JSON: " + err.message);
        })
        .finally(() => {
          this.isLoading = false;
          this.$process.disabled = false;
        });
    }

    fetchDefault() {
      if (this.abortCtrl) this.abortCtrl.abort();
      this.processRemote();
    }

    render(json) {
      const res  = json.resource || [];
      const frag = document.createDocumentFragment();
      const isRemote = this.lastProcessMode === "remote";

      const krpdiff = res.filter(i => i.dest?.endsWith(".krpdiff"));
      if (krpdiff.length) {
        const bytes = krpdiff.reduce((a, i) => a + (i.size || 0), 0);
        const sec = this.section(
          "File Patch (.krpdiff)",
          `Patch incremental untuk memperbarui instalasi game ke versi ini. Launcher menerapkannya saat proses update. Sejak versi 3.2, update dipecah menjadi beberapa paket diff kecil untuk unduhan paralel. Terdiri dari <strong>${krpdiff.length} file</strong>, total <strong>${formatSizeBoth(bytes)}</strong>.`
        );
        const inner = document.createDocumentFragment();
        krpdiff.forEach(i => inner.appendChild(this.boxPatch(i)));
        sec.lastChild.appendChild(inner);
        frag.appendChild(sec);
      }

      const exe = res.filter(i => /\.exe$/i.test(i.dest || ""));
      if (exe.length) {
        const bytes = exe.reduce((a, i) => a + (i.size || 0), 0);
        const sec = this.section(
          "File Executable",
          `Binary yang menjalankan game. Terletak di <code>Client/Binaries/Win64/</code>. Ukuran: <strong>${formatSizeBoth(bytes)}</strong>.`
        );
        const inner = document.createDocumentFragment();
        exe.forEach(i => inner.appendChild(this.boxExe(i)));
        sec.lastChild.appendChild(inner);
        frag.appendChild(sec);
      }

      const pak = res.filter(i =>
        i.dest?.endsWith("-WindowsNoEditor.pak") && !detectTier(i.dest)
      );
      if (pak.length) {
        const bytes = pak.reduce((a, i) => a + (i.size || 0), 0);
        const sec = this.section(
          "File Pak",
          `Aset utama game — model, tekstur, audio, dan data gameplay. Terdiri dari <strong>${pak.length} file</strong>, total <strong>${formatSizeBoth(bytes)}</strong>. File yang kurang akan diunduh oleh launcher.`
        );
        const inner = document.createDocumentFragment();
        pak.forEach(i => inner.appendChild(this.boxPak(i, false)));
        sec.lastChild.appendChild(inner);
        frag.appendChild(sec);
      }

      TIERS.forEach(tier => {
        const tierPak = res.filter(i => detectTier(i.dest) === tier);
        if (!tierPak.length) return;

        const bytes = tierPak.reduce((a, i) => a + (i.size || 0), 0);

        let baseDesc;
        if (tier === "UHD") {
          baseDesc = "Paket tekstur resolusi ultra-tinggi untuk preset grafis maksimal. Diperlukan jika kamu ingin mengaktifkan opsi Ultra Graphics di dalam game.";
        } else if (tier === "HD") {
          baseDesc = "Paket tekstur resolusi tinggi — tier default untuk PC.";
        } else {
          baseDesc = "Paket tekstur resolusi standar untuk menghemat ruang penyimpanan.";
        }

        const disclaimer = isRemote
          ? ` File ini berasal dari sumber default kami, sehingga belum tentu sesuai dengan kondisi instalasi game di berbagai pengguna.
          Jika folder ${tier} tidak tersedia di direktori game, kamu bisa melewati file ini. Sehingga, file yang diperlukan akan diunduh oleh launcher secara langsung, atau kamu dapat mengunggah file gameResources.json secara manual. Dengan begitu, semua file akan sesuai dengan instalasi game saat ini.`
          : "";

        const desc = `${baseDesc}${disclaimer} Terdiri dari <strong>${tierPak.length} file</strong>, total <strong>${formatSizeBoth(bytes)}</strong>.`;

        const sec = this.section(`File ${tier} Resource`, desc);
        const inner = document.createDocumentFragment();
        tierPak.forEach(i => inner.appendChild(this.boxPak(i, true)));
        sec.lastChild.appendChild(inner);
        frag.appendChild(sec);
      });

      const allTierPak = res.filter(i => detectTier(i.dest));
      if (krpdiff.length || pak.length || exe.length || allTierPak.length) {
        this.ef2Content = this.buildBatch([krpdiff, exe, pak, allTierPak]);
        frag.appendChild(
          this.sectionBatch(krpdiff.length, exe.length, pak.length, allTierPak.length)
        );
      }

      this.content.replaceChildren(frag);
    }

    section(title, desc) {
      const s = document.createElement("section");
      s.innerHTML = `<h3>${title}</h3><p>${desc}</p><div></div>`;
      return s;
    }

    box(innerHTML) {
      const d = document.createElement("div");
      d.className = "dlBox";
      d.innerHTML = innerHTML;
      return d;
    }

    boxExe(i) {
      return this.box(`
        <span class="fT" data-text="${this.cfg.label}"></span>
        <div class="fN">
          <span>${fileName(i.dest)}</span>
          <span class="fS">${formatSize(i.size || 0)}</span>
        </div>
        <button class="button wuwa-dl" aria-label="Download" data-url="${this.getFullUrl(i.dest)}">
          <i class="icon dl"></i>
        </button>`);
    }

    boxPatch(i) {
      return this.box(`
        <span class="fT" data-text="${this.cfg.label}"></span>
        <div class="fN">
          <span>${patchTitle(fileName(i.dest))}</span>
          <span class="fS">${formatSize(i.size || 0)}</span>
        </div>
        <button class="button wuwa-dl" aria-label="Download" data-url="${this.getFullUrl(i.dest)}">
          <i class="icon dl"></i>
        </button>`);
    }

    boxPak(i, isTiered) {
      const n = pakNumber(i.dest) || fileName(i.dest);
      const tier = detectTier(i.dest) || "";
      const title = isTiered ? `Pak ${tier} File ${n}` : `Pak File ${n}`;
      return this.box(`
        <span class="fT" data-text="${this.cfg.label}"></span>
        <div class="fN">
          <span>${title}</span>
          <span class="fS">${formatSize(i.size || 0)}</span>
        </div>
        <button class="button wuwa-dl" aria-label="Download" data-url="${this.getFullUrl(i.dest)}">
          <i class="icon dl"></i>
        </button>`);
    }

    sectionBatch(kc, ec, pc, hc) {
      const s = this.section(
        "Batch Download via Download Manager",
        `File .txt berisi seluruh tautan unduhan di atas untuk diimpor ke IDM, FDM, atau download manager lain. Isinya mencakup <strong>${kc} patch</strong>, <strong>${ec} executable</strong>, <strong>${pc} pak</strong>, dan <strong>${hc} resource</strong>.`
      );
      const kb = (this.ef2Content.length / 1024).toFixed(0);

      const batchTitle = this.cfg.fromLabel
        ? `Batch Download ${this.cfg.fromLabel} → ${this.cfg.label}`
        : `Batch Download ${this.cfg.label}`;

      s.lastChild.appendChild(this.box(`
        <span class="fT" data-text="${this.cfg.label}"></span>
        <div class="fN">
          <span>${batchTitle}</span>
          <span class="fS">${kb} KB</span>
        </div>
        <button class="button batch-dl" aria-label="Download"
                data-file="[Kauruka] WW ${this.cfg.version} - Batch Update.txt">
          <i class="icon dl"></i>
        </button>`));
      return s;
    }

    buildBatch(lists) {
      const out = [];
      lists.forEach(list => list.forEach(i => {
        if (i?.dest) out.push(this.getFullUrl(i.dest));
      }));
      return out.join("\n");
    }

    downloadEf2(content, name) {
      const blob = new Blob([content], { type: "text/plain" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  function init() {
    const root    = document.getElementById("json-gen");
    const content = document.getElementById("contentContainer");
    if (!root || root.__wuwaInit) return;
    root.__wuwaInit = true;

    const boot = () => {
      try { new WuwaViewer(root, content); }
      catch (err) { console.error("[wuwa-viewer] init error:", err); }
    };

    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            io.disconnect();
            boot();
            break;
          }
        }
      }, { rootMargin: "300px" });
      io.observe(root);
    } else {
      boot();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();