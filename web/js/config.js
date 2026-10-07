// Website settings. Fill SUPABASE_URL and SUPABASE_ANON_KEY once the Supabase
// project is set up (they are safe to publish: all data is protected by the
// database's row-level security). While they are empty, the site runs in
// DEMO mode with made-up sample data, so the clinic can try every screen.

export const CONFIG = {
  SUPABASE_URL: 'https://xbgcthpxwrjntfujejet.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_TsYhnIoJNDkq-al3_EXqRQ_b_BjNOR1',
  CLINIC_NAME: "Dr. Ali Rashid's Dental Clinic",
  STAFF_EMAIL_DOMAIN: 'dralirashid.com',
  TIMEZONE: 'Asia/Karachi',
  IMAGE_TRANSFORMS: false, // set true on a Supabase plan with image transformations
};

export const DEMO_MODE = !CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY;
