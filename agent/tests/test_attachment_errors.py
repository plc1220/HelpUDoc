"""A file the model rejects is explained in plain words."""


def test_a_rejected_attachment_is_explained_in_plain_words():
    from helpudoc_agent.api.routes.chat import _attachment_error_message

    error = "Error calling model 'gemini-3.5-flash' (Bad Request): 400 Bad Request. Request contains an invalid argument. INVALID_ARGUMENT"
    blocks = [{"type": "text", "text": "x"}, {"type": "file", "filename": "corrupt.pdf"}]
    assert "could not process corrupt.pdf" in _attachment_error_message(error, blocks)
    assert _attachment_error_message(error, [{"type": "text", "text": "x"}]) == error
    assert _attachment_error_message("503 unavailable", blocks) == "503 unavailable"
    # A fault in the request itself is not blamed on the file.
    own = "400 INVALID_ARGUMENT: must include at least one parts field"
    assert _attachment_error_message(own, blocks) == own
