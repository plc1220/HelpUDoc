# Paper2Slides Cache Bug - Root Cause Analysis

## Problem
When using the default options in the UI, Paper2Slides generates content that's off-context (e.g., "Attention is all you need", "LoRa finetuning") instead of using the actual uploaded file content.

## Root Cause
The caching mechanism in `agent/helpudoc_agent/paper2slides_runner.py` only uses **file content** to compute the cache key, but **ignores the options** (style, length, mode, output type, etc.).

### Current Implementation (Line 146-157)
```python
def _compute_cache_key(file_entries: Iterable[Tuple[str, bytes]]) -> str:
    """Return a stable, content-addressed key for the given files.

    Ordering is normalized by sanitized filename.
    """
    normalized = sorted(file_entries, key=lambda item: item[0])
    digest = hashlib.sha256()
    for name, blob in normalized:
        digest.update(name.encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(blob)
    return digest.hexdigest()[:32]
```

### The Issue
1. User uploads a file and generates slides with custom options → Result cached with key based only on file content
2. User uploads the **same file** again with **different options** (e.g., default "academic" style) → Cache returns the previous result instead of generating new slides
3. This causes the wrong content to be displayed

## What Needs to Change

### File: `agent/helpudoc_agent/paper2slides_runner.py`

#### Change 1: Update `_compute_cache_key` function signature and implementation (Lines 146-157)

**Before:**
```python
def _compute_cache_key(file_entries: Iterable[Tuple[str, bytes]]) -> str:
    """Return a stable, content-addressed key for the given files.

    Ordering is normalized by sanitized filename.
    """
    normalized = sorted(file_entries, key=lambda item: item[0])
    digest = hashlib.sha256()
    for name, blob in normalized:
        digest.update(name.encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(blob)
    return digest.hexdigest()[:32]
```

**After:**
```python
def _compute_cache_key(file_entries: Iterable[Tuple[str, bytes]], options: Dict[str, Any]) -> str:
    """Return a stable, content-addressed key for the given files and options.

    Ordering is normalized by sanitized filename.
    """
    normalized = sorted(file_entries, key=lambda item: item[0])
    digest = hashlib.sha256()
    for name, blob in normalized:
        digest.update(name.encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(blob)
    
    # Include options in cache key to avoid returning wrong results for different configurations
    options_str = json.dumps(options, sort_keys=True)
    digest.update(b"\0options\0")
    digest.update(options_str.encode("utf-8", errors="ignore"))
    return digest.hexdigest()[:32]
```

#### Change 2: Update the function call (Line 389)

**Before:**
```python
cache_key = _compute_cache_key(decoded_files)
```

**After:**
```python
cache_key = _compute_cache_key(decoded_files, options)
```

## Impact
- Cache keys will now be unique per combination of (file content + options)
- Different options on the same file will generate separate cached results
- Existing cache entries will become invalid (different key format), but this is expected and safe
- Users will get correct results for their selected options

## Testing
After making these changes, test by:
1. Upload a file with custom style/options → Generate slides
2. Upload the same file with default options → Should generate NEW slides, not return cached result
3. Upload the same file with the first custom options again → Should return cached result from step 1
