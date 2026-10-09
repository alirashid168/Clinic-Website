// SheetJS reads and writes Excel files in the browser. It is loaded from jsDelivr only when a file is read
// (Admin -> Import) or written (Checkups -> Download Excel); the page's content security policy allows that one host.
export const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs';
export const loadSheetJS = () => import(/* @vite-ignore */ XLSX_URL);
