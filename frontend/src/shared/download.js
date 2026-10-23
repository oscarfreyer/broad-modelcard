// Browser file downloads.

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Released a moment later: some browsers still read the URL after the click (large PDFs, the dataset).
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename, payload, spacing = 2) {
  downloadBlob(filename, new Blob([`${JSON.stringify(payload, null, spacing)}\n`], { type: 'application/json;charset=utf-8' }));
}
