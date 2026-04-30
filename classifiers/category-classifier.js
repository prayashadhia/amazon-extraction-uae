/**
 * classifiers/category-classifier.js
 *
 * Classifies an Amazon item description into one of 8 categories
 * using whole-word, case-insensitive regex matching.
 *
 * How matching works:
 *   - Each keyword is wrapped in \b...\b (word boundaries).
 *   - \b means "the point between a word character and a non-word character",
 *     so 'fan' matches "Fan Belt" but NOT "fancy" or "infant".
 *   - Matching is case-insensitive ('milk' matches "Milk", "MILK", "milk").
 *   - Categories are checked in order — the first match wins.
 *     Order is chosen to resolve ambiguity (e.g. Baby before Grocery).
 */

window.AmazonExporter = window.AmazonExporter || {};

window.AmazonExporter.classifyCategory = (function () {

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildRules(rawRules) {
    return rawRules.map(function (rule) {
      return {
        category: rule.category,
        patterns: rule.keywords.map(function (kw) {
          return new RegExp('\\b' + escapeRegex(kw) + '\\b', 'i');
        })
      };
    });
  }

  const RAW_RULES = [
    {
      // Checked FIRST — baby items overlap with Grocery (baby food, formula, milk)
      // and Household (toys with "cushion"), so Baby must win all ties.
      category: 'Baby',
      keywords: [
        // Diapers & hygiene
        'diaper', 'diapers', 'nappy', 'nappies', 'baby wipe', 'baby wipes',
        // Baby food — keywords + recognised brands
        'baby food', 'baby formula', 'infant formula', 'baby milk',
        'baby cereal', 'formula milk', 'infant milk', 'follow on milk',
        'follow-on milk', 'growing up milk',
        'puree', 'baby puree',
        'ella\'s kitchen', 'hero baby', 'gerber', 'hipp', 'nan optipro', 'kiddylicious',
        // Skincare & grooming
        'baby lotion', 'baby shampoo', 'baby wash', 'baby powder',
        'baby cream', 'baby oil', 'baby cleanser', 'baby soap',
        // Feeding
        'teether', 'teething', 'baby bottle', 'sippy cup', 'pacifier', 'dummy',
        // Gear
        'baby monitor', 'baby carrier', 'pram', 'stroller',
        'cot', 'crib', 'baby chair', 'high chair',
        // Safety & proofing
        'baby gate', 'safety gate', 'stair gate', 'baby proofing', 'baby proof',
        'outlet cover', 'socket cover', 'corner guard', 'corner protector',
        // Toys & play
        'baby toy', 'baby rattle', 'rattle', 'rattles', 'wrist rattle',
        'plush toy', 'plush toys', 'stuffed animal', 'stuffed toy',
        'rag doll', 'doll', 'dolls',
        'baby float', 'finger food',
        'baby puzzle', 'sensory toy', 'activity toy',
        // Potty
        'potty', 'potty training', 'potty chair', 'potty seat',
        // Clothing & bedding
        'baby gear', 'baby clothes', 'baby sleepsuit', 'baby grow',
        'onesie', 'baby blanket', 'swaddle', 'washcloth', 'baby washcloth',
        // People
        'toddler', 'toddlers', 'newborn', 'infant',
        // Brands
        'pampers', 'huggies', 'mamypoko', 'mamy poko'
      ]
    },
    {
      // Checked SECOND — before Foods & Beverages so that cooking staples
      // (oil, spices, flour) win over processed-food keywords.
      category: 'Grocery Essentials',
      keywords: [
        // Dairy
        'milk', 'fresh milk', 'full cream milk', 'skimmed milk', 'almond milk',
        'oat milk', 'soy milk', 'egg', 'eggs', 'butter', 'cheese',
        'yogurt', 'yoghurt', 'cream', 'fresh cream', 'cooking cream',
        // Bakery & grains
        'bread', 'flour', 'rice', 'pasta', 'semolina', 'oats', 'muesli', 'cereal',
        'atta', 'chakki', 'idly', 'idli', 'dosa', 'batter',
        // Sweeteners
        'sugar', 'jaggery', 'honey', 'jam',
        // Oils & condiments
        'peanut oil', 'olive oil', 'cooking oil', 'sunflower oil', 'vegetable oil', 'ghee',
        'peanut butter', 'nut butter', 'tomato paste', 'tomato sauce', 'vinegar',
        'soy sauce', 'ketchup', 'mayonnaise', 'mustard', 'pickle', 'salt',
        // Pulses & legumes
        'lentil', 'lentils', 'dal', 'chickpea', 'chickpeas',
        'kidney bean', 'kidney beans', 'black bean', 'black beans',
        // South Asian
        'paneer', 'masala', 'seasoning', 'stock cube', 'bouillon',
        // Canned & frozen
        'canned', 'tinned tuna', 'tinned salmon', 'sardine', 'sardines', 'baked beans',
        'frozen peas', 'frozen corn', 'frozen vegetables', 'frozen fruit',
        // Water
        'drinking water', 'bottled water',
        // Fruits
        'fruit', 'apple', 'apples', 'fresh apple', 'banana', 'bananas',
        'orange', 'oranges', 'mango', 'mangoes', 'grape', 'grapes',
        'strawberry', 'strawberries', 'blueberry', 'blueberries',
        'watermelon', 'lemon', 'lemons', 'lime', 'limes',
        'avocado', 'avocados', 'cherry', 'cherries',
        'mandarin', 'mandarins', 'kiwi', 'kiwis',
        'pear', 'pears', 'plum', 'plums', 'pomegranate', 'pomegranates',
        'beetroot',
        // Vegetables
        'vegetable', 'vegetables', 'tomato', 'tomatoes', 'potato', 'potatoes',
        'onion', 'onions', 'garlic', 'ginger', 'carrot', 'carrots',
        'cucumber', 'cucumbers', 'spinach', 'lettuce', 'broccoli',
        'cauliflower', 'capsicum', 'pepper', 'cabbage', 'palak',
        'mushroom', 'mushrooms', 'corn', 'baby corn', 'sweet corn',
        'green beans', 'french beans', 'string beans', 'runner beans',
        'edamame', 'okra', 'lady finger', 'tindly', 'tendli',
        'chilli', 'chillies', 'chili',
        // Herbs & spices
        'herbs', 'spice', 'spices', 'cumin', 'turmeric', 'coriander',
        'cardamom', 'cinnamon', 'clove', 'cloves', 'oregano',
        'rosemary', 'thyme', 'basil',
        // Household cleaning (also a supermarket aisle)
        'tissue', 'tissues', 'toilet paper', 'kitchen roll', 'paper towel', 'paper towels',
        'detergent', 'dishwash', 'dish soap', 'laundry', 'washing powder',
        'fabric softener', 'bleach', 'cleaning spray', 'surface cleaner',
        'toilet cleaner', 'floor cleaner', 'disinfectant',
        'soap', 'bar soap', 'hand soap', 'hand wash',
        // Personal care
        'shampoo', 'conditioner', 'body wash', 'shower gel', 'body lotion', 'lotion',
        'toothpaste', 'toothbrush', 'mouthwash', 'deodorant', 'deo', 'body spray',
        'face wash', 'moisturizer', 'moisturiser', 'sunscreen',
        'perfume', 'fragrance', 'eau de parfum', 'eau de toilette', 'cologne',
        'sanitary pad', 'sanitary pads', 'tampon', 'tampons', 'razor', 'razors', 'shaving',
        // Prevent lunch-bag tote from matching Fashion's 'tote' keyword
        'lunch bag', 'insulated bag'
      ]
    },
    {
      category: 'Foods & Beverages',
      keywords: [
        // Drinks (removed standalone 'water' — too broad, causes false positives
        // on body lotions and water pumps; specific forms kept below)
        'cola', 'coke', 'pepsi', 'sprite', 'fanta', '7up', '7-up', 'mountain dew',
        'red bull', 'monster energy', 'energy drink', 'soft drink', 'soda', 'fizzy',
        'juice', 'smoothie', 'lemonade', 'iced tea', 'green tea', 'black tea',
        'herbal tea', 'coffee', 'nescafe', 'espresso', 'cappuccino', 'latte',
        'mineral water', 'sparkling water', 'coconut water',
        'sports drink', 'gatorade', 'powerade',
        // Supplements & powders
        'protein shake', 'protein powder', 'whey protein', 'meal replacement',
        // Snacks
        'chips', 'crisps', 'popcorn', 'nachos', 'pretzels', 'cracker', 'crackers',
        'biscuit', 'biscuits', 'cookie', 'cookies', 'chocolate', 'candy',
        'sweet', 'sweets', 'gummy', 'lollipop',
        'muffin', 'donut', 'donuts', 'pastry', 'wafer', 'brownie', 'brownies',
        // 'cake' removed — matched bakeware (e.g. "Cake Tin Pan")
        'cake mix', 'birthday cake', 'celebration cake',
        'ice cream', 'gelato', 'sorbet', 'frozen yogurt',
        // Meals & ready food
        'pizza', 'burger', 'sandwich', 'wrap', 'hot dog', 'sausage', 'sausages',
        'instant noodle', 'instant noodles', 'maggi', 'ramen', 'cup noodle',
        'pasta sauce', 'ready meal', 'microwave meal', 'frozen meal', 'meal kit',
        'fries', 'french fries',
        // Indian & South Asian snacks
        'bhujia', 'aloo bhujia', 'foxnuts', 'makhana', 'sev', 'samosa', 'samosas',
        'pav bun', 'pav buns', 'haldiram',
        // Trail & health snacks
        'snack', 'snacks', 'trail mix', 'granola bar', 'energy bar', 'protein bar',
        // Nuts & dried fruit
        'nut', 'nuts', 'almond', 'almonds', 'cashew', 'cashews',
        'pistachio', 'pistachios', 'walnut', 'walnuts', 'peanut', 'peanuts',
        'dried fruit', 'raisin', 'raisins',
        'dried apricot', 'dried apricots',   // 'apricot' alone caused color-name false positives
        'fig', 'figs', 'prune', 'dates',
        // Condiments & dips
        'sauce', 'dip', 'salsa', 'hummus', 'guacamole',
        // Dairy alternatives & baking
        'milk powder', 'condensed milk', 'evaporated milk',
        'cooking chocolate', 'cocoa powder', 'vanilla extract',
        'yeast', 'baking powder', 'baking soda'
      ]
    },
    {
      category: 'Electronics',
      keywords: [
        // Phones
        'phone', 'smartphone', 'iphone', 'samsung galaxy', 'pixel', 'oneplus',
        'xiaomi', 'huawei', 'oppo', 'vivo', 'realme', 'nokia', 'motorola',
        // Computers
        'laptop', 'notebook', 'macbook', 'chromebook', 'ultrabook',
        // 'tablet' removed — matched medicine tablets; use specific forms below
        'android tablet', 'drawing tablet', 'graphics tablet', 'tablet computer',
        'ipad', 'kindle', 'e-reader',
        'desktop', 'pc', 'computer', 'monitor', 'display', 'screen',
        // Peripherals
        'keyboard', 'mouse', 'trackpad', 'webcam',
        'speaker', 'speakers', 'headphone', 'headphones',
        'earphone', 'earphones', 'earbud', 'earbuds',
        'airpod', 'airpods', 'headset', 'microphone',
        // TV & home entertainment
        'tv', 'television', 'smart tv', 'oled', 'qled', 'led tv',
        'projector', 'home theater', 'soundbar', 'subwoofer',
        // Photography & video
        'camera', 'dslr', 'mirrorless', 'lens', 'tripod', 'drone',
        // Office equipment
        'printer', 'scanner', 'ink cartridge',
        // 'toner' removed — matched face toner; use specific forms below
        'printer toner', 'toner cartridge',
        'paper shredder',
        // Networking
        'router', 'modem', 'network switch', 'ethernet', 'wifi extender',
        // Accessories & storage
        'powerbank', 'power bank', 'charger', 'cable', 'usb', 'hdmi',
        'memory card', 'sd card', 'hard drive', 'ssd', 'pen drive', 'usb drive',
        // Wearables
        'smartwatch', 'fitness tracker', 'smart band', 'garmin', 'fitbit',
        // Gaming
        'gaming', 'playstation', 'xbox', 'nintendo', 'controller', 'joystick',
        // PC components
        'graphics card', 'gpu', 'cpu', 'processor', 'ram', 'motherboard',
        'cooling fan', 'heatsink', 'power supply', 'ups', 'inverter',
        // Smart home
        'smart home', 'alexa', 'google home', 'smart plug', 'smart bulb',
        // Security
        'cctv', 'security camera', 'doorbell camera', 'dash cam',
        // Personal appliances
        'electric shaver', 'hair dryer', 'hair straightener', 'curling iron',
        'garment steamer', 'clothes steamer',
        // Home appliances
        'vacuum cleaner', 'robot vacuum', 'air purifier', 'humidifier',
        'electric kettle', 'microwave', 'oven', 'toaster', 'blender',
        'food processor', 'juicer', 'rice cooker', 'air fryer',
        'refrigerator', 'fridge', 'washing machine', 'dishwasher',
        'air conditioner', 'heater', 'steam iron', 'electric iron',
        // Fans — 'fan' alone removed; use specific forms to avoid "fancy", "infant" etc.
        'cooling fan', 'ceiling fan', 'desk fan', 'table fan', 'stand fan', 'tower fan', 'pedestal fan'
      ]
    },
    {
      category: 'Fashion',
      keywords: [
        // Tops — standalone 'top' removed; matched "Top Notes" in perfume descriptions
        'shirt', 't-shirt', 'tshirt', 'polo', 'blouse',
        'tank top', 'crop top', 'women top', 'ladies top', 'formal top',
        // Bottoms
        'trouser', 'trousers', 'pant', 'pants', 'jeans', 'chino', 'chinos',
        'shorts', 'skirt',
        // Full outfits
        'dress', 'gown', 'jumpsuit', 'romper', 'dungaree', 'dungarees', 'overalls',
        // Outerwear
        'jacket', 'coat', 'blazer', 'hoodie', 'sweatshirt', 'cardigan',
        'sweater', 'pullover', 'knitwear', 'vest', 'waistcoat',
        // Underwear & nightwear
        'underwear', 'boxer', 'boxers', 'brief', 'briefs', 'bra',
        'lingerie', 'socks', 'stocking', 'stockings',
        'pyjama', 'pyjamas', 'pajama', 'pajamas', 'nightwear', 'sleepwear', 'loungewear',
        // Footwear
        'shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers',
        'sandal', 'sandals', 'slipper', 'slippers', 'boot', 'boots',
        'heel', 'heels', 'loafer', 'loafers', 'oxford', 'moccasin',
        'flip flop', 'flip flops',
        // Bags & accessories
        'belt', 'buckle', 'wallet', 'handbag', 'purse', 'clutch', 'tote bag',
        'backpack', 'satchel', 'crossbody', 'duffel bag', 'luggage', 'suitcase',
        // Watches & jewellery
        'watch', 'sunglasses', 'glasses frame', 'jewellery', 'jewelry',
        'necklace', 'bracelet', 'ring', 'earring', 'earrings', 'pendant', 'brooch',
        // Headdress & accessories
        'scarf', 'shawl', 'hijab', 'abaya', 'kurta', 'thobe', 'kandura',
        'cap', 'hat', 'beanie', 'baseball cap', 'fedora',
        'glove', 'gloves', 'mitten', 'mittens', 'tie', 'bow tie', 'pocket square',
        // Swimwear & activewear
        'swimwear', 'bikini', 'swimsuit', 'rash guard', 'wetsuit',
        'sportswear', 'activewear', 'legging', 'leggings', 'yoga pants', 'gym wear',
        // Work & safety wear
        'uniform', 'workwear', 'safety vest', 'safety shoe', 'safety shoes'
      ]
    },
    {
      category: 'Books',
      keywords: [
        'book', 'books', 'novel', 'fiction', 'non-fiction', 'nonfiction',
        'biography', 'autobiography', 'memoir', 'self-help', 'self help',
        'personal development', 'productivity', 'motivation', 'leadership',
        'business book', 'management book', 'finance book', 'investing book',
        'history book', 'science book', 'philosophy', 'psychology book',
        'health book', 'fitness book', 'diet book', 'cookbook', 'recipe book',
        'travel guide', 'atlas', 'art book', 'photography book',
        "children's book", 'picture book', 'comic', 'manga',
        'graphic novel', 'textbook', 'workbook', 'study guide', 'exam prep',
        'dictionary', 'encyclopedia', 'thesaurus', 'almanac', 'handbook',
        'paperback', 'hardcover', 'hardback', 'e-book', 'ebook', 'audiobook'
      ]
    },
    {
      category: 'Household',
      keywords: [
        // Furniture & seating
        'sofa', 'couch', 'armchair', 'recliner', 'ottoman', 'footstool',
        // Bedroom
        'bed', 'bedframe', 'mattress', 'pillow', 'pillows', 'cushion', 'cushions',
        'blanket', 'blankets', 'duvet', 'comforter',
        'bed sheet', 'bed sheets', 'bed linen', 'towel', 'towels', 'bath mat',
        // Window & floor
        'curtain', 'curtains', 'blind', 'blinds', 'shutter', 'shutters',
        'rug', 'rugs', 'carpet', 'doormat', 'door mat',
        // Furniture & storage
        'dining table', 'coffee table', 'side table', 'desk', 'bookshelf',
        'wardrobe', 'cabinet', 'drawer', 'drawers', 'chest of drawers',
        'shoe rack', 'storage box', 'organiser', 'organizer', 'shelf', 'rack',
        'hanger', 'hangers', 'clothes rack', 'clothes hanger', 'laundry basket', 'ironing board',
        // Lighting & decor
        'lamp', 'light bulb', 'led bulb', 'chandelier', 'ceiling light',
        'floor lamp', 'desk lamp', 'wall light', 'fairy light', 'fairy lights',
        'picture frame', 'photo frame', 'canvas print', 'wall art', 'painting',
        'vase', 'plant pot', 'flower pot', 'planter', 'artificial plant',
        'candle', 'candles', 'diffuser', 'reed diffuser', 'air freshener', 'incense',
        'clock', 'wall clock', 'alarm clock',
        // Cleaning tools
        'broom', 'mop', 'dustpan', 'trash can', 'bin', 'waste bin',
        'garbage bag', 'trash bag', 'bin bag', 'bin liner',
        'sponge', 'scrub sponge', 'scourer', 'sponge cloth',
        'wiper', 'floor wiper',
        'drain opener', 'drain cleaner', 'drain unblocker',
        // Tools & DIY
        'tool', 'tools', 'drill', 'hammer', 'screwdriver', 'wrench', 'plier', 'pliers',
        'tape measure', 'ladder', 'toolkit', 'tool set',
        'paint', 'paintbrush', 'roller brush', 'sandpaper', 'putty',
        'adhesive tape', 'double sided tape', 'foam tape',
        // Bathroom
        'curtain rod', 'towel rail', 'toilet brush', 'bath accessories',
        'shower curtain', 'shower head', 'faucet', 'tap',
        // Water dispensers
        'water dispenser', 'water pump', 'water cooler',
        // Kitchen
        'kitchen cabinet', 'kitchen shelf', 'utensil', 'utensils',
        'spatula', 'ladle', 'pot', 'pots', 'pan', 'pans', 'frying pan',
        'wok', 'casserole', 'baking tray', 'cake tin', 'baking tin', 'loaf pan',
        'cutting board', 'knife', 'knives', 'peeler', 'grater', 'colander',
        'plate', 'plates', 'bowl', 'bowls', 'cup', 'cups', 'mug', 'mugs',
        'glass', 'glasses', 'jug', 'flask',
        'tupperware', 'lunch box', 'food container', 'meal prep container',
        // Garden & pest control
        'garden', 'gardening', 'hose', 'lawn mower', 'plant food',
        'fertilizer', 'fertiliser', 'pesticide', 'insecticide', 'mousetrap', 'bug spray'
      ]
    }
  ];

  const RULES = buildRules(RAW_RULES);

  /**
   * @param {string} description  The item's name / description string.
   * @returns {string}            One of the 8 category names.
   */
  return function classifyCategory(description) {
    if (!description || typeof description !== 'string') return 'Others';

    for (var i = 0; i < RULES.length; i++) {
      var patterns = RULES[i].patterns;
      for (var j = 0; j < patterns.length; j++) {
        if (patterns[j].test(description)) {
          return RULES[i].category;
        }
      }
    }

    return 'Others';
  };

})();
