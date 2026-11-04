-- País y moneda de cada negocio (H7a parte 2). El país decide cómo se completan los
-- teléfonos sin prefijo, la zona horaria por defecto y la moneda de los precios.
-- Los negocios que ya existían eran de EE.UU. en la práctica; los nuevos, de Chile si no se dice otra cosa.
-- En la v1 no se cambian después del alta (cambiar la moneda obligaría a convertir los precios).
ALTER TABLE tenants ADD COLUMN country text NOT NULL DEFAULT 'US';
ALTER TABLE tenants ADD COLUMN currency text NOT NULL DEFAULT 'USD';
ALTER TABLE tenants ALTER COLUMN country SET DEFAULT 'CL';
ALTER TABLE tenants ALTER COLUMN currency SET DEFAULT 'CLP';
ALTER TABLE tenants ADD CONSTRAINT tenants_country_currency CHECK (
  (country = 'CL' AND currency = 'CLP') OR (country = 'US' AND currency = 'USD')
);

-- Precio en la unidad mínima de la moneda del negocio: pesos (CLP) o centavos (USD).
ALTER TABLE services RENAME COLUMN price_cents TO price;
COMMENT ON COLUMN services.price IS 'En la unidad mínima de tenants.currency: pesos (CLP) o centavos (USD)';
