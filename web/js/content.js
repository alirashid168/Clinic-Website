// Public website wording. Edit here to change what visitors read.
// Items marked TO CONFIRM need Dr. Ali's approval before going live.
//
// Wording written as a function of `f` quotes facts worked out from the
// database (see clinicFacts() in views/schedule.js), so it cannot go stale:
//   f.count        number of active branches
//   f.cities       "Karachi, Lahore and Islamabad"
//   f.walkInCount  branches with fixed opening days; f.walkInCities their cities
//   f.visitCities  cities whose branches open only on Dr. Ali's visit dates
// When the database cannot be reached, f.count is 0 and the general sentence is used.

const clinics = (n) => `${n} ${n === 1 ? 'clinic' : 'clinics'}`;

// TO CONFIRM: the clinic's phone and WhatsApp, used whenever the settings in the
// database cannot be read (and on the error page). Taken from the live WhatsApp
// number on 2026-10-07; the phone is assumed to be the same number.
export const CONTACT = { phone: '+92 310 0000464', whatsapp: '923100000464', tel: '+923100000464' };

// Braces pricing as approved by the clinic owner on 2026-10-08. The per-kit prices below are not shown.
export const BRACES_PRICING = 'Monthly charges Rs 4,000, and advance starting from Rs 35,000 only.';

// Confirmed by the clinic owner on 2026-10-08. The only place the review count is written (the Meet section reads it).
export const GOOGLE_REVIEWS = '200+';

export const VISITOR = {
  intro: 'Straighter teeth and a confident smile, planned by Dr. Ali Rashid and treated by a team that follows one careful protocol at every branch.',
  benefits: (f) => [
    { title: 'One protocol, every month', body: 'Every braces visit follows the same month-by-month plan, so you know what happens at each appointment and nothing gets missed.' },
    { title: 'Senior doctors at key months', body: 'Months with big decisions, such as extractions and progress photos, are handled by the senior doctor group and checked again.' },
    { title: 'Progress photos you can see', body: 'Your before, progress and after photos are saved to your own patient account, along with your X-rays and invoices.' },
    f.walkInCount
      ? { title: `Walk in at ${f.walkInCount} ${f.walkInCities} ${f.walkInCount === 1 ? 'branch' : 'branches'}`, body: `${f.visitCities ? `${f.visitCities} open on Dr. Ali's visit dates, so please message us before travelling there. ` : ''}Every branch shares one patient record, so your treatment continues wherever you visit.` }
      : { title: 'One record at every branch', body: 'All our branches share one patient record, so your treatment continues wherever you visit. Please message us before your first visit.' },
    { title: 'Retainers made in-house', body: 'Retainers are made in our own lab, so they are ready faster and fit the result we planned.' },
    { title: 'Direct line to Dr. Ali', body: 'Any concern can be sent straight to Dr. Ali from your patient account.' },
  ],
  // Braces options. Only BRACES_PRICING is shown; the kit prices are kept for reference and stay hidden.
  // The kits are named by rank because nothing else is known yet; once Dr. Ali confirms what each kit
  // contains (for example metal, ceramic or self-ligating brackets), name each one by that and list the differences.
  braces: [
    { name: 'Standard kit', price: 'Rs 55,000', body: 'Complete braces treatment with our standard kit. Monthly visits included in the plan.' },
    { name: 'Upgraded kit', price: 'Rs 70,000', body: 'Upgraded kit for most cases. Your doctor explains the difference at your check-up.' },
    { name: 'Premium kit', price: 'Rs 80,000', body: 'Premium kit for longer or more complex cases.' },
    { name: 'Top-tier kit', price: 'Rs 120,000', body: 'Top-tier kit, recommended for selected cases.' },
  ],
  bracesNote: 'Your doctor recommends the right kit after a check-up and X-ray.',
  otherTreatments: ['Smile makeovers', 'Veneers', 'Crowns', 'Root canal treatment', 'Scaling and polishing', 'Fillings', 'Extractions', 'Retainers'],
};

// Homepage wording carried over from the old dralirashid.com website.
export const HOME = {
  // "Meet Dr. Ali" section on the homepage (it replaces the earlier trust strip and "about" box).
  meet: {
    role: 'Founder and lead dentist',
    name: ['Dr. Ali', 'Rashid'],
    credential: 'BDS, Baqai University',
    founded: 'Founded 17 September 2017',
    body: (f) => [
      `Dr. Ali Rashid leads a team of dentists across ${f.count ? `${clinics(f.count)} in ${f.cities}` : 'our clinics'}. His work centres on braces, smile makeovers and veneers, and on the moment a patient first sees their finished smile.`,
      'Every braces patient follows the same month-by-month plan at every branch, with senior doctors at the months that matter most. Your progress photos, X-rays and invoices are kept in your own patient account.',
    ],
    photo: 'img/dr-ali.jpg',
    photoWidth: 682,
    photoHeight: 909,
    photoAlt: 'Dr. Ali Rashid in clinic scrubs, smiling with his arms crossed',
  },
  rating: { count: GOOGLE_REVIEWS, text: 'positive reviews across all our branches' },
  // TO CONFIRM: a general Google Maps search. Replace with the clinic's Google Business listing link(s).
  reviewsUrl: 'https://www.google.com/maps/search/?api=1&query=Dr.+Ali+Rashid%27s+Dental+Clinic',
  social: [
    { name: 'Facebook', url: 'https://www.facebook.com/dr.alirashid168/' },
    { name: 'YouTube', url: 'https://www.youtube.com/@dralirashid168' },
  ],
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
