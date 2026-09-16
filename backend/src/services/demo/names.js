// ============================================================
// FICTIONAL DEMO IDENTITIES.
//
// Every name here is invented for this seed: a common Indian given name
// paired with a common surname, chosen so a gym owner in India reads the
// member list and recognises it as a plausible roster rather than test
// data. None is taken from a real person, a customer record, or any
// external list -- the spec is explicit that demo data must be fictional,
// and the whole point of this file is that the pairing is arbitrary.
//
// Kept apart from seed.js purely so that file stays about structure and
// this one stays about content -- and so a founder who wants a different
// roster for a different prospect edits one short list, not a seeder.
// ============================================================

/** Given names, split by gender so the seeded age/gender/goal mix reads
 *  naturally rather than randomly assigning "Priya, male". */
export const MALE_FIRST_NAMES = [
  'Aarav', 'Rohan', 'Aditya', 'Rahul', 'Vikram', 'Karthik', 'Siddharth', 'Nikhil',
  'Arjun', 'Manish', 'Varun', 'Rohit', 'Aniket', 'Pranav', 'Harsh', 'Gaurav',
  'Kunal', 'Devansh', 'Sandeep', 'Yash', 'Abhishek', 'Ritesh', 'Naveen', 'Sameer',
  'Tarun', 'Vivek', 'Akash', 'Mohit', 'Ishaan', 'Rajeev', 'Suresh', 'Anand',
  'Kabir', 'Dhruv', 'Nitin', 'Ashwin', 'Vinay', 'Raghav', 'Shaurya', 'Prateek',
];

export const FEMALE_FIRST_NAMES = [
  'Ananya', 'Priya', 'Sneha', 'Neha', 'Kavya', 'Divya', 'Meera', 'Ishita',
  'Aditi', 'Pooja', 'Shruti', 'Nandini', 'Riya', 'Swati', 'Anjali', 'Lakshmi',
  'Tanvi', 'Megha', 'Nisha', 'Deepika', 'Sanjana', 'Vaishnavi', 'Rashmi', 'Bhavna',
  'Trisha', 'Preeti', 'Sonal', 'Aarthi', 'Gayatri', 'Simran', 'Maya', 'Charu',
  'Radhika', 'Sakshi', 'Jyoti', 'Namrata', 'Ruchi', 'Kirti', 'Aparna', 'Shalini',
];

export const SURNAMES = [
  'Sharma', 'Rao', 'Mehta', 'Nair', 'Verma', 'Kapoor', 'Singh', 'Iyer',
  'Reddy', 'Menon', 'Desai', 'Bhatia', 'Joshi', 'Pillai', 'Chauhan', 'Patel',
  'Kulkarni', 'Gupta', 'Shetty', 'Malhotra', 'Bose', 'Naidu', 'Saxena', 'Dutta',
  'Agarwal', 'Chopra', 'Hegde', 'Krishnan', 'Deshpande', 'Banerjee', 'Trivedi', 'Sinha',
];

/** The four trainers the demo gym runs on. Fixed rather than generated:
 *  the spec names the roles it wants a prospect to see (a strength coach,
 *  a general trainer, a PT, a nutrition-and-fitness coach), and Arjun in
 *  particular is the persona the role switcher lands on -- see
 *  personas.js, which must keep the same email. */
export const DEMO_TRAINERS = [
  { name: 'Arjun Deshpande', email: 'arjun@befitter.demo', specialization: 'Strength Coach', bio: 'Powerlifting background. Builds the strength blocks and runs the Saturday heavy session.', maxClients: 30 },
  { name: 'Megha Krishnan', email: 'megha@befitter.demo', specialization: 'Fitness Trainer', bio: 'Group classes and conditioning. Handles most of the morning floor.', maxClients: 30 },
  { name: 'Rohit Bhatia', email: 'rohit@befitter.demo', specialization: 'Personal Trainer', bio: 'One-to-one coaching, return-from-injury programming, evening slots.', maxClients: 20 },
  { name: 'Nisha Pillai', email: 'nisha@befitter.demo', specialization: 'Nutrition & Fitness Coach', bio: 'Writes the meal plans and reviews weekly food logs with members.', maxClients: 25 },
];

/** Community posts the seeded members have written. Ordinary gym talk,
 *  deliberately unremarkable -- a feed of slogans reads as marketing copy,
 *  and the prospect is meant to recognise their own members here. */
export const COMMUNITY_POSTS = [
  'Completed my first 10K steps today!',
  'Finished Week 4 of my strength program.',
  'Consistency beats motivation.',
  'Hit a new personal best today!',
  'Down 3 kg since I joined. Slow, but it is moving.',
  'First time squatting bodyweight for reps. Took 5 months.',
  '6am class is brutal but I have not missed one in three weeks.',
  'Anyone else doing the transformation challenge? Week 2 here.',
  'Deadlift finally clicked after Arjun fixed my setup.',
  'Protein target hit 6 days out of 7 this week.',
  'Rest day. Legs need it after yesterday.',
  'Back after two weeks off travelling. Starting light.',
  'Megha added a finisher to the circuit. I regret everything.',
  '5 kg on my bench since April. Taking it.',
  'Hit 80 kg squat for 5. New territory for me.',
  'Meal prep done for the week. Half the battle.',
  'Evening slot is so much quieter. Switched permanently.',
  'One month streak on the app today.',
];

export const COMMUNITY_COMMENTS = [
  'Massive. Well done!',
  'Strong work 👏',
  'This is the consistency I need.',
  'Congrats! That is a big jump.',
  'Same, the 6am class is no joke.',
  'Keep going, you have earned it.',
  'What programme are you running?',
  'Nice one. Recovery day tomorrow?',
  'Inspiring. I am starting next week.',
  'That setup cue changed everything for me too.',
];
