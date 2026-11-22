-- =====================================================================
-- 2200  AUTHORISED SIGNATORY ON LETTERS
-- Signature image (company-assets bucket, uploaded by settings managers) plus optional signatory name and title,
-- printed in the sign-off of offer, appointment, relieving and experience letters.
-- Additive only: no table dropped, no data deleted, no policy changed.
-- =====================================================================
alter table public.companies add column if not exists signature_url text;
alter table public.companies add column if not exists signatory_name text check (char_length(signatory_name) <= 100);
alter table public.companies add column if not exists signatory_title text check (char_length(signatory_title) <= 100);
