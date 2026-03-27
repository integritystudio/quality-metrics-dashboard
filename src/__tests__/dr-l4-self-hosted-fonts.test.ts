/**
 * Self-hosted Google Fonts
 * Verifies that Google Fonts are no longer loaded from an external URL,
 * that local @font-face declarations exist for both required families,
 * and that the font files are present in public/fonts/.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DASHBOARD_ROOT = resolve(__dirname, '../../');
const THEME_CSS = resolve(DASHBOARD_ROOT, 'src/theme.css');
const PUBLIC_FONTS_DIR = resolve(DASHBOARD_ROOT, 'public/fonts');

const REQUIRED_FAMILIES = ['JetBrains Mono', 'IBM Plex Sans'] as const;
const REQUIRED_WEIGHTS = [400, 500, 600] as const;

const EXPECTED_FONT_FILES: Record<string, string[]> = {
  'JetBrains Mono': [
    'JetBrainsMono-Regular.woff2',
    'JetBrainsMono-Medium.woff2',
    'JetBrainsMono-SemiBold.woff2',
  ],
  'IBM Plex Sans': [
    'IBMPlexSans-Regular.woff2',
    'IBMPlexSans-Medium.woff2',
    'IBMPlexSans-SemiBold.woff2',
  ],
};


describe('theme.css — no external Google Fonts import', () => {
  it('should not contain a fonts.googleapis.com @import', () => {
    const css = readFileSync(THEME_CSS, 'utf-8');
    expect(css).not.toMatch(/fonts\.googleapis\.com/);
  });

  it('should not contain any external @import url starting with https://', () => {
    const css = readFileSync(THEME_CSS, 'utf-8');
    // Allow local relative @imports; reject any @import pointing to http/https
    const externalImport = /@import\s+url\(['"]?https?:\/\//;
    expect(css).not.toMatch(externalImport);
  });
});


describe('local @font-face declarations exist', () => {
  function getFontFaceSource(): string {
    // Accept declarations in theme.css itself or a sibling fonts.css
    const fontsCss = resolve(DASHBOARD_ROOT, 'src/fonts.css');
    if (existsSync(fontsCss)) {
      return readFileSync(fontsCss, 'utf-8');
    }
    return readFileSync(THEME_CSS, 'utf-8');
  }

  it('should declare @font-face for JetBrains Mono', () => {
    const css = getFontFaceSource();
    expect(css).toMatch(/font-family:\s*['"]?JetBrains Mono['"]?/i);
  });

  it('should declare @font-face for IBM Plex Sans', () => {
    const css = getFontFaceSource();
    expect(css).toMatch(/font-family:\s*['"]?IBM Plex Sans['"]?/i);
  });

  for (const family of REQUIRED_FAMILIES) {
    for (const weight of REQUIRED_WEIGHTS) {
      it(`should have a @font-face block for ${family} weight ${weight}`, () => {
        const css = getFontFaceSource();
        // Find all @font-face blocks that mention this family
        const fontFaceBlocks = [...css.matchAll(/@font-face\s*\{[^}]+\}/g)].map(m => m[0]);
        const familyBlocks = fontFaceBlocks.filter(block =>
          new RegExp(`font-family:\\s*['"]?${family}['"]?`, 'i').test(block)
        );
        const hasWeight = familyBlocks.some(block =>
          new RegExp(`font-weight:\\s*${weight}`).test(block)
        );
        expect(hasWeight, `Expected @font-face for "${family}" with font-weight: ${weight}`).toBe(true);
      });
    }
  }

  it('should reference /fonts/ local path in @font-face src', () => {
    const css = getFontFaceSource();
    expect(css).toMatch(/url\(['"]?\/fonts\//);
  });
});


describe('public/fonts/ directory and font files exist', () => {
  it('should have a public/fonts/ directory', () => {
    expect(existsSync(PUBLIC_FONTS_DIR), `Expected directory: ${PUBLIC_FONTS_DIR}`).toBe(true);
  });

  for (const [family, files] of Object.entries(EXPECTED_FONT_FILES)) {
    for (const file of files) {
      it(`should have font file public/fonts/${file} for ${family}`, () => {
        const filePath = resolve(PUBLIC_FONTS_DIR, file);
        expect(existsSync(filePath), `Expected font file at: ${filePath}`).toBe(true);
      });
    }
  }
});
