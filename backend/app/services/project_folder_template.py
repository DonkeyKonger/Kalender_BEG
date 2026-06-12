PROJECT_FOLDER_TEMPLATE = [
    {"sort_order": 1, "name": "Angebote", "folder_key": "angebote", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 2, "name": "Nachtragsangebote", "folder_key": "nachtragsangebote", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 3, "name": "Aufträge", "folder_key": "auftraege", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 4, "name": "Leistungsverzeichnis", "folder_key": "leistungsverzeichnis", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 5, "name": "Terminplan", "folder_key": "terminplan", "visible_for_roles": ["admin", "project_manager", "office", "monteur"]},
    {"sort_order": 6, "name": "Schriftverkehr", "folder_key": "schriftverkehr", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 7, "name": "Rechnungen", "folder_key": "rechnungen", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 8, "name": "Aufmass", "folder_key": "aufmass", "visible_for_roles": ["admin", "project_manager", "office", "monteur"]},
    {"sort_order": 9, "name": "Dokumentation", "folder_key": "dokumentation", "visible_for_roles": ["admin", "project_manager", "office", "monteur"]},
    {"sort_order": 10, "name": "Zeichnungen", "folder_key": "zeichnungen", "visible_for_roles": ["admin", "project_manager", "office", "monteur"]},
    {"sort_order": 11, "name": "Lieferantenbestellungen", "folder_key": "lieferantenbestellungen", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 12, "name": "Fremdangebote", "folder_key": "fremdangebote", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 13, "name": "Lagerbestellungen", "folder_key": "lagerbestellungen", "visible_for_roles": ["admin", "project_manager", "office"]},
    {"sort_order": 14, "name": "Fotos", "folder_key": "fotos", "visible_for_roles": ["admin", "project_manager", "office", "monteur"]},
    {"sort_order": 15, "name": "Mails", "folder_key": "mails", "visible_for_roles": ["admin", "project_manager", "office"]},
]

PROJECT_FOLDER_TEMPLATE_BY_KEY = {folder["folder_key"]: folder for folder in PROJECT_FOLDER_TEMPLATE}
