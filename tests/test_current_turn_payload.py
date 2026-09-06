from helpudoc_agent.api.message_utils import prepare_current_turn_payload


def test_enriched_current_request_replaces_visible_history_text():
    history = [{"role": "assistant", "content": "Deck ready"}, {"role": "user", "content": "Preview forest"}]
    prompt = 'SLIDE_STYLE_PREVIEW {"source":"launch.html","output":".style-preview-test.html"}\nPreview forest'
    result = prepare_current_turn_payload(prompt, history)
    assert result[-1]["content"] == prompt
    assert len(result) == 2
    assert history[-1]["content"] == "Preview forest"


def test_new_turn_does_not_replace_historical_user():
    history = [{"role": "user", "content": "Create deck"}, {"role": "assistant", "content": "Done"}]
    assert prepare_current_turn_payload("Edit slide 1", history) == history + [{"role": "user", "content": "Edit slide 1"}]


def test_preserves_attachments_and_does_not_mutate_history():
    blocks = [{"type": "text", "text": "Edit"}, {"type": "image_url", "image_url": {"url": "test.png"}}]
    result = prepare_current_turn_payload("Edit @launch.html", [{"role": "human", "content": blocks}])
    assert result[-1]["content"][0]["text"] == "Edit @launch.html"
    assert result[-1]["content"][1] == blocks[1]
    assert blocks[0]["text"] == "Edit"


def test_explicit_multimodal_content_takes_precedence():
    blocks = [{"type": "text", "text": "Current"}]
    assert prepare_current_turn_payload("Fallback", [{"role": "user", "content": "Old"}], blocks)[-1]["content"] == blocks


def test_empty_request_retains_history_and_empty_history_gets_user():
    history = [{"role": "assistant", "content": "Done"}]
    assert prepare_current_turn_payload("", history) == history
    assert prepare_current_turn_payload("Hello") == [{"role": "user", "content": "Hello"}]
