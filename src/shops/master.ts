// The master list the demo shops sell from: 144 everyday products in 16 categories. Each shop
// stocks about 100 of them (see catalog.ts), at its own prices and in its own style.
// Format: key | name | category | base price in cents | one-line description.
// Words kept out on purpose: the demo requests ("PS5 disc edition", "wireless earbuds") must
// match exactly the hand-written products, so none of these names or descriptions use them.

export interface MasterItem {
  key: string;
  name: string;
  category: string;
  priceCents: number;
  blurb: string;
}

export const CATEGORIES = [
  "electronics", "computers", "gaming", "audio", "home", "kitchen", "garden", "clothing",
  "sports", "outdoor", "beauty", "toys", "books", "office", "pets", "gift cards",
] as const;

const RAW = `
tablet-10|Tablet, 10 inch|computers|18900|64 GB storage, sharp screen and all-day battery.
laptop-14|Laptop, 14 inch|computers|59900|Fast start-up, light enough to carry daily.
laptop-stand|Laptop stand, aluminium|computers|3400|Raises the screen to eye level, folds flat.
usb-stick-128|USB stick, 128 GB|computers|1500|Small and quick, with a keyring loop.
ssd-1tb|External SSD, 1 TB|computers|8900|Pocket-sized storage that copies files fast.
wifi-router|Wi-Fi router, dual band|computers|5900|Covers a three-bedroom home without dead spots.
ethernet-cable|Network cable, 5 metre|computers|900|Flat cable, easy to hide along a wall.
laptop-sleeve|Laptop sleeve, 14 inch|computers|2200|Padded and water resistant.
docking-station|Docking station, 12 ports|computers|11900|One cable to power, screen and everything else.
game-pad-pro|Game pad, wired|gaming|2900|Comfortable grips and long cable for the sofa.
gaming-headset|Gaming headset|gaming|4900|Clear voice microphone and soft ear cups.
gaming-mouse|Gaming mouse|gaming|3900|Six buttons and adjustable speed.
racing-wheel|Racing wheel and pedals|gaming|12900|Force feedback that clamps to a desk.
gaming-chair|Gaming chair|gaming|15900|Adjustable arms and a deep recline.
mouse-mat-xl|Mouse mat, extra large|gaming|1800|Covers the whole desk with a smooth surface.
controller-charger|Controller charging dock|gaming|2400|Charges two controllers at once.
board-game-night|Board game, family night|gaming|3200|Two to six players, about 45 minutes.
card-game-deck|Card game, party edition|gaming|1600|Quick rounds that suit any group.
headphones-over-ear|Headphones, over-ear|audio|7900|Deep bass and a folding frame.
headphones-kids|Headphones for kids|audio|2200|Volume limited for young ears.
soundbar-2|Soundbar with subwoofer|audio|13900|Fills a living room from one slim bar.
turntable|Record player, belt drive|audio|9900|Plays 33 and 45 speed records.
mic-usb|Microphone, USB|audio|5900|Plug-in recording for calls and podcasts.
speaker-shelf|Bookshelf speakers, pair|audio|11900|Warm sound for a desk or a shelf.
aux-cable|Audio cable, 2 metre|audio|700|Braided cable with gold plugs.
headphone-stand|Headphone stand|audio|1900|Keeps ear cups off the desk.
radio-retro|Radio, retro style|audio|4500|Wood finish with analogue dial.
table-lamp|Table lamp, dimmable|home|2900|Warm light with three brightness steps.
throw-blanket|Throw blanket, fleece|home|2400|Soft and machine washable.
cushion-pair|Cushion covers, pair|home|1800|Zip covers in a woven fabric.
wall-clock|Wall clock, silent|home|2200|No ticking and easy to read.
photo-frame-set|Photo frames, set of 5|home|2600|Mixed sizes in a matte black finish.
storage-baskets|Storage baskets, set of 3|home|3400|Woven baskets that stack or nest.
door-mat|Door mat, coir|home|1900|Scrapes mud off shoes.
candle-trio|Candles, scented trio|home|2100|Clean-burning wax in glass jars.
shower-curtain|Shower curtain, water repellent|home|1700|Weighted hem keeps it in place.
bed-sheets-queen|Bed sheets, queen|home|5900|Cotton, deep pocket, soft after one wash.
vacuum-cordless|Vacuum cleaner, cordless|home|14900|Runs for 40 minutes on one charge.
air-purifier|Air purifier, small room|home|8900|Quiet fan with a washable filter.
coffee-maker|Coffee maker, 10 cup|kitchen|5900|Timer and a glass jug.
chef-knife|Chef knife, 20 cm|kitchen|3900|Sharp steel blade, balanced handle.
pan-set|Frying pans, set of 2|kitchen|4900|Non-stick coating, any hob.
cutting-board|Cutting board, bamboo|kitchen|2200|Large board with a juice groove.
blender|Blender, 1 litre|kitchen|4500|Crushes ice and makes smooth soups.
toaster-4|Toaster, 4 slice|kitchen|3900|Wide slots and a crumb tray.
mixing-bowls|Mixing bowls, set of 4|kitchen|2400|Steel bowls with grip bases.
food-storage|Food containers, set of 10|kitchen|2800|Leak-proof lids, freezer safe.
kitchen-scale|Kitchen scale, digital|kitchen|1600|Weighs to the gram.
water-filter-jug|Water filter jug|kitchen|2700|Fits a fridge door shelf.
plant-pots|Plant pots, set of 3|garden|2200|Drainage holes and saucers included.
garden-hose|Garden hose, 15 metre|garden|3400|Kink-resistant with a spray head.
pruning-shears|Pruning shears|garden|1900|Cuts branches up to 2 cm thick.
seed-kit-herbs|Herb seed kit|garden|1500|Basil, parsley and mint to start on a sill.
watering-can|Watering can, 5 litre|garden|1700|Long spout and a detachable rose.
garden-gloves|Garden gloves|garden|1100|Grippy palms, breathable back.
solar-lights|Solar garden lights, 6 pack|garden|2900|Come on at dusk with no wiring.
compost-bin|Compost bin, 200 litre|garden|5900|Turns scraps into soil in a season.
raised-bed|Raised garden bed|garden|7900|Cedar frame, assembles in minutes.
t-shirt-cotton|T-shirt, cotton|clothing|1500|Soft, plain and true to size.
hoodie-grey|Hoodie, grey|clothing|3900|Brushed inside, deep front pocket.
jeans-straight|Jeans, straight fit|clothing|4900|Sturdy denim with a little stretch.
running-shorts|Running shorts|clothing|2200|Light fabric with a zip pocket.
scarf-wool|Scarf, wool|clothing|2400|Long enough to wrap twice.
gloves-touch|Gloves, touchscreen|clothing|1800|Warm lining, works with a phone.
belt-leather|Belt, leather|clothing|2600|Solid buckle, five holes.
sunglasses|Sunglasses, polarised|clothing|2900|Cut glare for driving and the beach.
baseball-cap|Cap, adjustable|clothing|1600|Curved peak and breathable band.
yoga-mat|Yoga mat, 6 mm|sports|2900|Non-slip surface with a carry strap.
dumbbells-pair|Dumbbells, pair 5 kg|sports|3900|Rubber coated with a flat base.
resistance-bands|Resistance bands, set of 5|sports|1800|Five strengths and a door anchor.
jump-rope|Jump rope|sports|1100|Adjustable length with ball bearings.
football-size5|Football, size 5|sports|2400|Stitched panels and a durable skin.
tennis-racket|Tennis racket|sports|5900|Light frame with a comfortable grip.
bike-helmet|Bike helmet|sports|3900|Adjustable fit with rear light.
swim-goggles|Swim goggles|sports|1400|Anti-fog lenses and a soft seal.
foam-roller|Foam roller|sports|2100|Firm roller for sore muscles.
tent-2p|Tent, 2 person|outdoor|11900|Pitches in minutes and packs small.
sleeping-mat|Sleeping mat, inflatable|outdoor|5900|Thick, quiet and quick to pump up.
camp-chair|Camp chair, folding|outdoor|3400|Packs into a carry bag.
trekking-boots|Trekking boots|outdoor|12900|Waterproof lining and grippy soles.
dry-bag-20|Dry bag, 20 litre|outdoor|1900|Roll-top seal keeps contents dry.
compass|Compass, baseplate|outdoor|1400|Clear scale and a luminous needle.
multi-tool|Multi-tool, 12 functions|outdoor|3400|Pliers, knife and screwdrivers in one.
thermal-flask|Thermal flask, 1 litre|outdoor|2900|Hot for twelve hours.
trail-map-case|Map case, waterproof|outdoor|1200|Clear window and a neck cord.
face-wash|Face wash, gentle|beauty|1200|Fragrance free for daily use.
moisturiser|Moisturiser, SPF 30|beauty|1800|Light cream that sinks in quickly.
shampoo-pair|Shampoo and conditioner|beauty|1900|Mild formula for every day.
hair-dryer|Hair dryer, 2000 W|beauty|3400|Three heat settings and a cool shot.
electric-toothbrush|Electric toothbrush|beauty|3900|Two-minute timer and two brush heads.
razor-set|Razor and blades set|beauty|1600|Five blades and a pivot head.
hand-cream|Hand cream, 3 pack|beauty|1400|Rich cream that is not greasy.
nail-kit|Nail care kit|beauty|1300|Clippers, file and cuticle tools.
bath-salts|Bath salts, lavender|beauty|1500|Relaxing soak in a reusable jar.
building-blocks|Building blocks, 500 pieces|toys|3400|Bright bricks that fit all major sets.
puzzle-1000|Jigsaw puzzle, 1000 pieces|toys|1800|Cut from thick board with a poster.
plush-bear|Plush bear|toys|1900|Soft toy that washes at 30 degrees.
toy-train|Wooden train set|toys|3900|Track, bridge and three carriages.
art-set-kids|Art set for kids|toys|2200|Crayons, paints and a drawing pad.
remote-car|Remote control car|toys|2900|Rechargeable and good on rough ground.
dolls-house|Dolls house, wooden|toys|6900|Four rooms with furniture.
water-blaster|Water blaster|toys|1400|Fills fast and shoots far.
kite-delta|Kite, delta wing|toys|1500|Easy to fly with a winder.
novel-mystery|Mystery novel, paperback|books|1100|A page-turner set in a seaside town.
cookbook-weekday|Cookbook, weekday dinners|books|2200|One hundred quick recipes.
atlas-world|World atlas|books|2900|Clear maps and flags of every country.
dictionary-eng|English dictionary|books|1900|Plain definitions and word origins.
kids-stories|Bedtime stories collection|books|1600|Twenty short tales to read aloud.
sketchbook-a4|Sketchbook, A4|books|1200|Heavy paper that handles ink.
notebook-set|Notebooks, set of 3|books|1100|Ruled pages and a lay-flat spine.
history-short|A short history of the world|books|1800|The big events in plain words.
language-guide|Phrasebook, five languages|books|1300|Pocket-sized with a pronunciation guide.
office-chair|Office chair, mesh back|office|9900|Lumbar support and height adjustment.
desk-lamp-led|Desk lamp, LED|office|2900|Five colour temperatures and a USB port.
standing-desk|Standing desk converter|office|11900|Lifts a laptop and keyboard to elbow height.
stapler|Stapler, desktop|office|900|Staples twenty sheets at once.
printer-paper|Printer paper, 500 sheets|office|900|Bright white, 80 gsm.
pen-pack|Pens, pack of 20|office|800|Smooth black ink.
desk-organiser|Desk organiser|office|1900|Slots for pens, phone and notes.
whiteboard|Whiteboard, 90 by 60 cm|office|3400|Magnetic with a marker tray.
shredder|Paper shredder|office|5900|Cross-cut for ten sheets.
dog-bed|Dog bed, medium|pets|3400|Washable cover and a non-slip base.
cat-tree|Cat tree|pets|5900|Two perches and a scratching post.
dog-lead|Dog lead, 2 metre|pets|1400|Padded handle and strong clip.
pet-bowls|Pet bowls, steel pair|pets|1200|Dishwasher safe with a rubber base.
cat-litter|Cat litter, 10 litre|pets|1600|Clumps well and keeps smells down.
dog-toy-set|Dog toys, set of 6|pets|1800|Rope, ball and squeaky pieces.
fish-tank-kit|Fish tank starter kit|pets|6900|Filter, light and a 30 litre tank.
bird-feeder|Bird feeder|pets|1700|Hangs from a branch and holds a kilo of seed.
pet-brush|Pet grooming brush|pets|1300|Lifts loose hair without scratching.
gift-card-25|Gift card, $25|gift cards|2500|Digital code, delivered by email.
gift-card-100|Gift card, $100|gift cards|10000|Digital code, delivered by email.
gift-card-10|Gift card, $10|gift cards|1000|Digital code, delivered by email.
gift-card-75|Gift card, $75|gift cards|7500|Digital code, delivered by email.
gift-card-20|Gift card, $20|gift cards|2000|Digital code, delivered by email.
gift-card-150|Gift card, $150|gift cards|15000|Digital code, delivered by email.
phone-case|Phone case, shock proof|electronics|1500|Raised edges protect the screen.
phone-charger-20w|Phone charger, 20 W|electronics|1900|Charges most phones to half in 30 minutes.
phone-stand|Phone stand|electronics|1100|Folds flat and holds any angle.
car-charger|Car charger, dual port|electronics|1600|Charges two devices at once.
smart-watch|Smart watch|electronics|7900|Heart rate, sleep and step tracking.
fitness-band|Fitness band|electronics|3900|Seven days of battery.
e-reader|E-reader, 6 inch|electronics|9900|Glare-free screen for reading outdoors.
camera-action|Action camera|electronics|8900|Waterproof to ten metres.
projector-mini|Mini projector|electronics|11900|Shows a big picture on any wall.
battery-aa-12|AA batteries, 12 pack|electronics|1100|Long-life alkaline cells.
tripod-flex|Tripod, flexible|electronics|1700|Wraps around poles and branches.
smart-bulb-4|Smart bulbs, 4 pack|electronics|2900|Change colour from your phone.
`;

export const MASTER: MasterItem[] = RAW.trim()
  .split("\n")
  .map((line) => {
    const [key, name, category, price, blurb] = line.split("|");
    return { key: key!, name: name!, category: category!, priceCents: Number(price), blurb: blurb! };
  });
