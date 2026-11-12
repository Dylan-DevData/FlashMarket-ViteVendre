-- Données de départ (relançable sans doublons)

INSERT INTO cities (name, region) VALUES
  ('Bafoussam', 'Ouest'),
  ('Dschang',   'Ouest'),
  ('Yaoundé',   'Centre'),
  ('Douala',    'Littoral'),
  ('Bamenda',   'Nord-Ouest'),
  ('Bertoua',   'Est'),
  ('Garoua',    'Nord'),
  ('Maroua',    'Extrême-Nord'),
  ('Ebolowa',   'Sud'),
  ('Kribi',     'Sud')
ON CONFLICT (name) DO NOTHING;

-- Les clés de allowed_attributes sont des identifiants techniques ;
-- les libellés affichés (« Eau permanente »…) seront gérés côté application.
INSERT INTO categories (slug, name, default_price_unit, uses_stock, expiry_days, allowed_attributes, is_active) VALUES
  ('logements-a-louer', 'Logements à louer', 'month', FALSE, 30,
     ARRAY['eau', 'electricite', 'securite', 'balcon', 'parking', 'cloture', 'carrelage', 'meuble', 'douche_interne', 'cuisine_interne'], TRUE),
  ('vivres-frais', 'Vivres frais', 'bag', TRUE, 3,
     ARRAY['gros_calibre', 'bio', 'vente_en_gros', 'vente_au_detail', 'livraison'], TRUE),
  ('pret-a-porter', 'Prêt-à-porter', 'unit', TRUE, 30,
     ARRAY['neuf', 'occasion', 'homme', 'femme', 'enfant'], TRUE)
ON CONFLICT (slug) DO UPDATE SET is_active = EXCLUDED.is_active;
