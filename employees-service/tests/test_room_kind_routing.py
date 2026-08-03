from hivemind_employees.hyper.skills import resolve_room_kind


def test_general_room_tag_is_authoritative_over_task_vocabulary():
    assert resolve_room_kind(
        "ROOM_GENERAL",
        "Handle direct company instructions through the normal Room Director.",
        "Build an ICP and market audience persona for a regulated company.",
    ) == "general"


def test_general_room_tag_is_language_independent():
    assert resolve_room_kind(
        "ROOM_GENERAL",
        "Allgemeiner Unternehmensraum",
        "Erstelle eine Marktstrategie und ein Kundenprofil.",
    ) == "general"
