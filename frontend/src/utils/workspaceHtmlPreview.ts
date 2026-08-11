type WorkspacePreviewPayload = {
  content?: unknown;
  encoding?: unknown;
};

export const previewPayloadToHtml = (payload: WorkspacePreviewPayload): string => {
  if (typeof payload.content !== 'string') {
    return '';
  }
  if (payload.encoding === 'base64') {
    try {
      return decodeURIComponent(Array.from(atob(payload.content), (character) => (
        `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`
      )).join(''));
    } catch {
      return '';
    }
  }
  return payload.content;
};
