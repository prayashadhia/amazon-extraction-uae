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
 *
 * Categories:
 *   Baby | Grocery Essentials | Foods & Beverages | Electronics
 *   Fashion | Books | Household | Others
 */

window.AmazonExporter = window.AmazonExporter || {};

window.AmazonExporter.classifyCategory = (function () {

  // Escapes special regex characters in a keyword string so they are treated
  // as plain text. Example: 'j.k. rowling' → 'j\.k\. rowling'
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Pre-compiles each keyword into a regex at load time (not per call),
  // so classification is fast even with large keyword lists.
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
      // Checked first — baby items overlap with Grocery (baby food, formula)
      // and Fashion (baby clothes), so Baby must win those ties.
      category: 'Baby',
      keywords: [
        'diaper', 'diapers', 'nappy', 'nappies', 'baby wipe', 'baby wipes',
        'baby food', 'baby formula', 'infant formula', 'baby milk',
        'baby cereal', 'baby lotion', 'baby shampoo', 'baby wash',
        'baby powder', 'baby cream', 'baby oil', 'teether', 'teething',
        'baby bottle', 'sippy cup', 'pacifier', 'dummy', 'baby monitor',
        'baby carrier', 'pram', 'stroller', 'cot', 'crib', 'baby chair',
        'high chair', 'baby toy', 'baby rattle', 'toddler', 'newborn',
        'infant', 'pampers', 'huggies', 'mamypoko', 'mamy poko',
        'baby gear', 'baby clothes', 'baby sleepsuit', 'baby grow',
        'onesie', 'baby blanket', 'swaddle'
      ]
    },
    {
      category: 'Grocery Essentials',
      keywords: [
        'milk', 'fresh milk', 'full cream milk', 'skimmed milk', 'almond milk',
        'oat milk', 'soy milk', 'egg', 'eggs', 'bread', 'butter', 'cheese',
        'yogurt', 'yoghurt', 'cream', 'flour', 'rice', 'pasta', 'sugar', 'salt',
        'olive oil', 'cooking oil', 'sunflower oil', 'vegetable oil', 'ghee',
        'lentil', 'lentils', 'dal', 'chickpea', 'chickpeas', 'kidney bean',
        'kidney beans', 'black bean', 'black beans', 'oats', 'muesli', 'cereal',
        'honey', 'jam', 'peanut butter', 'nut butter',
        'tomato paste', 'tomato sauce', 'vinegar', 'soy sauce', 'ketchup',
        'mayonnaise', 'mustard', 'pickle', 'fruit', 'vegetable', 'vegetables',
        'banana', 'bananas', 'orange', 'oranges', 'mango', 'mangoes',
        'grape', 'grapes', 'strawberry', 'strawberries', 'blueberry', 'blueberries',
        'watermelon', 'lemon', 'lemons', 'lime', 'limes', 'avocado', 'avocados',
        'tomato', 'tomatoes', 'potato', 'potatoes', 'onion', 'onions',
        'garlic', 'ginger', 'carrot', 'carrots', 'cucumber', 'cucumbers',
        'spinach', 'lettuce', 'broccoli', 'cauliflower', 'capsicum', 'pepper',
        'herbs', 'spice', 'spices', 'cumin', 'turmeric', 'coriander', 'cardamom',
        'cinnamon', 'clove', 'cloves', 'masala', 'seasoning', 'stock cube', 'bouillon',
        'canned', 'tinned tuna', 'tinned salmon', 'sardine', 'sardines', 'baked beans',
        'frozen peas', 'frozen corn', 'frozen vegetables', 'frozen fruit',
        'tissue', 'tissues', 'toilet paper', 'kitchen roll', 'paper towel', 'paper towels',
        'detergent', 'dishwash', 'dish soap', 'laundry', 'washing powder',
        'fabric softener', 'bleach', 'cleaning spray', 'surface cleaner',
        'hand soap', 'shampoo', 'conditioner', 'body wash', 'shower gel',
        'toothpaste', 'toothbrush', 'mouthwash', 'deodorant', 'face wash',
        'moisturizer', 'moisturiser', 'sunscreen', 'sanitary pad', 'sanitary pads',
        'tampon', 'tampons', 'razor', 'razors', 'shaving'
      ]
    },
    {
      category: 'Foods & Beverages',
      keywords: [
        'cola', 'coke', 'pepsi', 'sprite', 'fanta', '7up', '7-up', 'mountain dew',
        'red bull', 'monster energy', 'energy drink', 'soft drink', 'soda', 'fizzy',
        'juice', 'smoothie', 'lemonade', 'iced tea', 'green tea', 'black tea',
        'herbal tea', 'coffee', 'nescafe', 'espresso', 'cappuccino', 'latte',
        'water', 'mineral water', 'sparkling water', 'coconut water',
        'protein shake', 'protein powder', 'whey protein', 'meal replacement',
        'chips', 'crisps', 'popcorn', 'nachos', 'pretzels', 'cracker', 'crackers',
        'biscuit', 'biscuits', 'cookie', 'cookies', 'chocolate', 'candy', 'sweet',
        'sweets', 'gummy', 'lollipop', 'cake', 'muffin', 'donut', 'donuts',
        'pastry', 'wafer', 'brownie', 'brownies',
        'ice cream', 'gelato', 'sorbet', 'frozen yogurt',
        'pizza', 'burger', 'sandwich', 'wrap', 'hot dog', 'sausage', 'sausages',
        'instant noodle', 'instant noodles', 'maggi', 'ramen', 'cup noodle',
        'pasta sauce', 'ready meal', 'microwave meal', 'frozen meal', 'meal kit',
        'snack', 'snacks', 'trail mix', 'granola bar', 'energy bar', 'protein bar',
        'nut', 'nuts', 'almond', 'almonds', 'cashew', 'cashews', 'pistachio',
        'pistachios', 'walnut', 'walnuts', 'peanut', 'peanuts', 'dried fruit',
        'dates', 'raisin', 'raisins', 'apricot', 'apricots', 'fig', 'figs', 'prune',
        'sauce', 'dip', 'salsa', 'hummus', 'guacamole',
        'sports drink', 'gatorade', 'powerade',
        'milk powder', 'condensed milk', 'evaporated milk',
        'cooking chocolate', 'cocoa powder', 'vanilla extract',
        'yeast', 'baking powder', 'baking soda'
      ]
    },
    {
      category: 'Electronics',
      keywords: [
        'phone', 'smartphone', 'iphone', 'samsung galaxy', 'pixel', 'oneplus',
        'xiaomi', 'huawei', 'oppo', 'vivo', 'realme', 'nokia', 'motorola',
        'laptop', 'notebook', 'macbook', 'chromebook', 'ultrabook',
        'tablet', 'ipad', 'kindle', 'e-reader',
        'desktop', 'pc', 'computer', 'monitor', 'display', 'screen',
        'keyboard', 'mouse', 'trackpad', 'webcam', 'speaker', 'speakers',
        'headphone', 'headphones', 'earphone', 'earphones', 'earbud', 'earbuds',
        'airpod', 'airpods', 'headset', 'microphone',
        'tv', 'television', 'smart tv', 'oled', 'qled', 'led tv',
        'projector', 'home theater', 'soundbar', 'subwoofer',
        'camera', 'dslr', 'mirrorless', 'lens', 'tripod', 'drone',
        'printer', 'scanner', 'ink cartridge', 'toner', 'paper shredder',
        'router', 'modem', 'network switch', 'ethernet', 'wifi extender',
        'powerbank', 'power bank', 'charger', 'cable', 'usb', 'hdmi',
        'memory card', 'sd card', 'hard drive', 'ssd', 'pen drive', 'usb drive',
        'smartwatch', 'fitness tracker', 'smart band', 'garmin', 'fitbit',
        'gaming', 'playstation', 'xbox', 'nintendo', 'controller', 'joystick',
        'graphics card', 'gpu', 'cpu', 'processor', 'ram', 'motherboard',
        'cooling fan', 'heatsink', 'power supply', 'ups', 'inverter',
        'smart home', 'alexa', 'google home', 'smart plug', 'smart bulb',
        'cctv', 'security camera', 'doorbell camera', 'dash cam',
        'electric shaver', 'hair dryer', 'hair straightener', 'curling iron',
        'vacuum cleaner', 'robot vacuum', 'air purifier', 'humidifier',
        'electric kettle', 'microwave', 'oven', 'toaster', 'blender',
        'food processor', 'juicer', 'rice cooker', 'air fryer',
        'refrigerator', 'fridge', 'washing machine', 'dishwasher',
        'air conditioner', 'fan', 'heater', 'steam iron', 'electric iron'
      ]
    },
    {
      category: 'Fashion',
      keywords: [
        'shirt', 't-shirt', 'tshirt', 'polo', 'blouse', 'top', 'tank top',
        'trouser', 'trousers', 'pant', 'pants', 'jeans', 'chino', 'chinos',
        'shorts', 'skirt', 'dress', 'gown', 'jumpsuit', 'romper', 'dungaree',
        'dungarees', 'overalls', 'jacket', 'coat', 'blazer', 'hoodie',
        'sweatshirt', 'cardigan', 'sweater', 'pullover', 'knitwear', 'vest',
        'waistcoat', 'underwear', 'boxer', 'boxers', 'brief', 'briefs', 'bra',
        'lingerie', 'socks', 'stocking', 'stockings', 'pyjama', 'pyjamas',
        'pajama', 'pajamas', 'nightwear', 'sleepwear', 'loungewear',
        'shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers',
        'sandal', 'sandals', 'slipper', 'slippers', 'boot', 'boots',
        'heel', 'heels', 'loafer', 'loafers', 'oxford', 'moccasin',
        'flip flop', 'flip flops', 'belt', 'buckle', 'wallet', 'handbag',
        'purse', 'clutch', 'tote', 'backpack', 'satchel', 'crossbody',
        'duffel bag', 'luggage', 'suitcase',
        'watch', 'sunglasses', 'glasses frame', 'jewellery', 'jewelry',
        'necklace', 'bracelet', 'ring', 'earring', 'earrings', 'pendant', 'brooch',
        'scarf', 'shawl', 'hijab', 'abaya', 'kurta', 'thobe', 'kandura',
        'cap', 'hat', 'beanie', 'baseball cap', 'fedora', 'glove', 'gloves',
        'mitten', 'mittens', 'tie', 'bow tie', 'pocket square',
        'swimwear', 'bikini', 'swimsuit', 'rash guard', 'wetsuit',
        'sportswear', 'activewear', 'legging', 'leggings', 'yoga pants', 'gym wear',
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
        'sofa', 'couch', 'armchair', 'recliner', 'ottoman', 'footstool',
        'bed', 'bedframe', 'mattress', 'pillow', 'pillows', 'cushion', 'cushions',
        'blanket', 'blankets', 'duvet', 'comforter', 'bed sheet', 'bed sheets',
        'bed linen', 'towel', 'towels', 'bath mat',
        'curtain', 'curtains', 'blind', 'blinds', 'shutter', 'shutters',
        'rug', 'rugs', 'carpet', 'doormat',
        'dining table', 'coffee table', 'side table', 'desk', 'bookshelf',
        'wardrobe', 'cabinet', 'drawer', 'drawers', 'chest of drawers',
        'shoe rack', 'storage box', 'organiser', 'organizer', 'shelf', 'rack',
        'lamp', 'light bulb', 'led bulb', 'chandelier', 'ceiling light',
        'floor lamp', 'desk lamp', 'wall light', 'fairy light', 'fairy lights',
        'picture frame', 'photo frame', 'canvas print', 'wall art', 'painting',
        'vase', 'plant pot', 'flower pot', 'planter', 'artificial plant',
        'candle', 'candles', 'diffuser', 'reed diffuser', 'air freshener', 'incense',
        'clock', 'wall clock', 'alarm clock',
        'broom', 'mop', 'dustpan', 'trash can', 'bin', 'waste bin',
        'laundry basket', 'clothes rack', 'clothes hanger', 'ironing board',
        'tool', 'tools', 'drill', 'hammer', 'screwdriver', 'wrench', 'plier',
        'pliers', 'tape measure', 'ladder', 'toolkit', 'tool set',
        'paint', 'paintbrush', 'roller brush', 'sandpaper', 'putty',
        'curtain rod', 'towel rail', 'toilet brush', 'bath accessories',
        'shower curtain', 'shower head', 'faucet', 'tap',
        'kitchen cabinet', 'kitchen shelf', 'utensil', 'utensils',
        'spatula', 'ladle', 'pot', 'pots', 'pan', 'pans', 'frying pan',
        'wok', 'casserole', 'baking tray', 'cutting board', 'knife', 'knives',
        'peeler', 'grater', 'colander', 'plate', 'plates', 'bowl', 'bowls',
        'cup', 'cups', 'mug', 'mugs', 'glass', 'glasses', 'jug', 'flask',
        'tupperware', 'lunch box', 'food container', 'meal prep container',
        'garden', 'gardening', 'hose', 'lawn mower', 'plant food',
        'fertilizer', 'fertiliser', 'pesticide', 'insecticide', 'mousetrap', 'bug spray'
      ]
    }
  ];

  // Build compiled regex patterns once at load time
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
