/**
 * classifiers/category-classifier.js
 *
 * Classifies an Amazon item description into one of 8 categories
 * using keyword matching. Falls back to 'Others' when no keywords match.
 *
 * Categories:
 *   Grocery Essentials | Foods & Beverages | Baby | Fashion
 *   Electronics | Household | Books | Others
 */

window.AmazonExporter = window.AmazonExporter || {};

window.AmazonExporter.classifyCategory = (function () {

  // Keywords are checked case-insensitively against the item description.
  // Order matters: earlier categories win when keywords overlap.
  const RULES = [
    {
      category: 'Baby',
      keywords: [
        'diaper', 'nappy', 'nappies', 'baby wipe', 'baby food', 'baby formula',
        'infant formula', 'baby milk', 'baby cereal', 'baby lotion', 'baby shampoo',
        'baby wash', 'baby powder', 'baby cream', 'baby oil', 'teether', 'teething',
        'baby bottle', 'sippy cup', 'pacifier', 'dummy', 'baby monitor', 'baby carrier',
        'pram', 'stroller', 'cot ', 'crib', 'baby chair', 'high chair', 'baby toy',
        'baby rattle', 'toddler', 'newborn', 'infant', 'pampers', 'huggies',
        'mamypoko', 'mamy poko', 'baby gear', 'baby clothes', 'baby sleepsuit',
        'baby grow', 'onesie', 'baby blanket', 'swaddle'
      ]
    },
    {
      category: 'Grocery Essentials',
      keywords: [
        'milk', 'fresh milk', 'full cream milk', 'skimmed milk', 'almond milk',
        'oat milk', 'soy milk', 'egg', 'eggs', 'bread', 'butter', 'cheese',
        'yogurt', 'yoghurt', 'cream', 'flour', 'rice', 'pasta', 'sugar', 'salt',
        'olive oil', 'cooking oil', 'sunflower oil', 'vegetable oil', 'ghee',
        'lentil', 'dal', 'chickpea', 'kidney bean', 'black bean', 'oats',
        'muesli', 'cereal', 'honey', 'jam', 'peanut butter', 'nut butter',
        'tomato paste', 'tomato sauce', 'vinegar', 'soy sauce', 'ketchup',
        'mayonnaise', 'mustard', 'pickle', 'fruit ', 'vegetable', 'apple',
        'banana', 'orange', 'mango', 'grape', 'strawberry', 'blueberry',
        'watermelon', 'lemon', 'lime', 'avocado', 'tomato', 'potato',
        'onion', 'garlic', 'ginger', 'carrot', 'cucumber', 'spinach',
        'lettuce', 'broccoli', 'cauliflower', 'capsicum', 'pepper',
        'herbs', 'spice', 'cumin', 'turmeric', 'coriander', 'cardamom',
        'cinnamon', 'clove', 'masala', 'seasoning', 'stock cube', 'bouillon',
        'canned', 'tinned tuna', 'tinned salmon', 'sardine', 'baked beans',
        'frozen pea', 'frozen corn', 'frozen vegetable', 'frozen fruit',
        'tissue', 'toilet paper', 'kitchen roll', 'paper towel',
        'detergent', 'dishwash', 'dish soap', 'laundry', 'washing powder',
        'fabric softener', 'bleach', 'cleaning spray', 'surface cleaner',
        'hand soap', 'shampoo', 'conditioner', 'body wash', 'shower gel',
        'toothpaste', 'toothbrush', 'mouthwash', 'deodorant', 'face wash',
        'moisturizer', 'sunscreen', 'sanitary pad', 'tampon', 'razor', 'shaving'
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
        'chips', 'crisps', 'popcorn', 'nachos', 'pretzels', 'cracker',
        'biscuit', 'cookie', 'chocolate', 'candy', 'sweet', 'gummy', 'lollipop',
        'cake', 'muffin', 'donut', 'pastry', 'wafer', 'brownie',
        'ice cream', 'gelato', 'sorbet', 'frozen yogurt',
        'pizza', 'burger', 'sandwich', 'wrap', 'hot dog', 'sausage',
        'instant noodle', 'maggi', 'ramen', 'cup noodle', 'pasta sauce',
        'ready meal', 'microwave meal', 'frozen meal', 'meal kit',
        'snack', 'trail mix', 'granola bar', 'energy bar', 'protein bar',
        'nut ', 'almond', 'cashew', 'pistachio', 'walnut', 'peanut', 'dried fruit',
        'dates', 'raisin', 'apricot', 'fig', 'prune',
        'sauce', 'dip', 'salsa', 'hummus', 'guacamole',
        'protein shake', 'sports drink', 'gatorade', 'powerade',
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
        'desktop', 'pc ', 'computer', 'monitor', 'display', 'screen',
        'keyboard', 'mouse', 'trackpad', 'webcam', 'speaker', 'headphone',
        'earphone', 'earbud', 'airpod', 'headset', 'microphone',
        'tv ', 'television', 'smart tv', 'oled', 'qled', 'led tv',
        'projector', 'home theater', 'soundbar', 'subwoofer',
        'camera', 'dslr', 'mirrorless', 'lens', 'tripod', 'drone',
        'printer', 'scanner', 'ink cartridge', 'toner', 'paper shredder',
        'router', 'modem', 'network switch', 'ethernet', 'wifi extender',
        'powerbank', 'power bank', 'charger', 'cable', 'usb', 'hdmi',
        'memory card', 'sd card', 'hard drive', 'ssd', 'pen drive', 'usb drive',
        'smartwatch', 'fitness tracker', 'smart band', 'garmin', 'fitbit',
        'gaming', 'playstation', 'xbox', 'nintendo', 'controller', 'joystick',
        'graphics card', 'gpu', 'cpu', 'processor', 'ram', 'motherboard',
        'cooling fan', 'heatsink', 'power supply', 'ups ', 'inverter',
        'smart home', 'alexa', 'google home', 'smart plug', 'smart bulb',
        'cctv', 'security camera', 'doorbell camera', 'dash cam',
        'electric shaver', 'hair dryer', 'straightener', 'curling iron',
        'vacuum cleaner', 'robot vacuum', 'air purifier', 'humidifier',
        'electric kettle', 'microwave', 'oven', 'toaster', 'blender',
        'mixer', 'food processor', 'juicer', 'rice cooker', 'air fryer',
        'refrigerator', 'fridge', 'washing machine', 'dishwasher',
        'air conditioner', 'fan ', 'heater', 'iron ', 'steam iron'
      ]
    },
    {
      category: 'Fashion',
      keywords: [
        'shirt', 't-shirt', 'tshirt', 'polo', 'blouse', 'top ', 'tank top',
        'trouser', 'pant ', 'pants', 'jeans', 'chino', 'shorts', 'skirt',
        'dress', 'gown', 'jumpsuit', 'romper', 'dungaree', 'overalls',
        'jacket', 'coat', 'blazer', 'hoodie', 'sweatshirt', 'cardigan',
        'sweater', 'pullover', 'knitwear', 'vest ', 'waistcoat',
        'underwear', 'boxer', 'brief', 'bra', 'lingerie', 'socks', 'stocking',
        'pyjama', 'pajama', 'nightwear', 'sleepwear', 'loungewear',
        'shoe', 'sneaker', 'trainer', 'sandal', 'slipper', 'boot ',
        'heel', 'flat ', 'loafer', 'oxford', 'moccasin', 'flip flop',
        'belt ', 'buckle', 'wallet', 'handbag', 'purse', 'clutch', 'tote',
        'backpack', 'satchel', 'crossbody', 'duffel bag', 'luggage', 'suitcase',
        'watch ', 'sunglasses', 'glasses frame', 'jewellery', 'jewelry',
        'necklace', 'bracelet', 'ring ', 'earring', 'pendant', 'brooch',
        'scarf', 'shawl', 'hijab', 'abaya', 'kurta', 'thobe', 'kandura',
        'cap ', 'hat ', 'beanie', 'baseball cap', 'fedora',
        'glove', 'mitten', 'tie ', 'bow tie', 'pocket square',
        'swimwear', 'bikini', 'swimsuit', 'rash guard', 'wetsuit',
        'sportswear', 'activewear', 'legging', 'yoga pant', 'gym wear',
        'uniform', 'workwear', 'safety vest', 'safety shoe'
      ]
    },
    {
      category: 'Books',
      keywords: [
        'book ', 'books', 'novel', 'fiction', 'non-fiction', 'nonfiction',
        'biography', 'autobiography', 'memoir', 'self-help', 'self help',
        'personal development', 'productivity', 'motivation', 'leadership',
        'business book', 'management book', 'finance book', 'investing book',
        'history book', 'science book', 'philosophy', 'psychology book',
        'health book', 'fitness book', 'diet book', 'cookbook', 'recipe book',
        'travel guide', 'atlas', 'map book', 'art book', 'photography book',
        'children book', "children's book", 'picture book', 'comic', 'manga',
        'graphic novel', 'textbook', 'workbook', 'study guide', 'exam prep',
        'dictionary', 'encyclopedia', 'thesaurus', 'almanac', 'handbook',
        'paperback', 'hardcover', 'hardback', 'e-book', 'ebook', 'audiobook',
        'by j.k. rowling', 'by stephen king', 'by james clear', 'by malcolm gladwell'
      ]
    },
    {
      category: 'Household',
      keywords: [
        'sofa', 'couch', 'armchair', 'recliner', 'ottoman', 'footstool',
        'bed ', 'bedframe', 'mattress', 'pillow', 'cushion', 'blanket',
        'duvet', 'comforter', 'bed sheet', 'bed linen', 'towel', 'bath mat',
        'curtain', 'blind ', 'shutter', 'rug ', 'carpet', 'doormat',
        'dining table', 'coffee table', 'side table', 'desk ', 'bookshelf',
        'wardrobe', 'cabinet', 'drawer', 'chest of drawers', 'shoe rack',
        'storage box', 'organiser', 'organizer', 'shelf ', 'rack ',
        'lamp ', 'light bulb', 'led bulb', 'chandelier', 'ceiling light',
        'floor lamp', 'desk lamp', 'wall light', 'fairy light',
        'picture frame', 'photo frame', 'canvas print', 'wall art', 'painting',
        'vase', 'plant pot', 'flower pot', 'planter', 'artificial plant',
        'candle', 'diffuser', 'reed diffuser', 'air freshener', 'incense',
        'clock ', 'wall clock', 'alarm clock',
        'broom', 'mop ', 'dustpan', 'trash can', 'bin ', 'waste bin',
        'laundry basket', 'clothes rack', 'clothes hanger', 'ironing board',
        'tool ', 'drill ', 'hammer', 'screwdriver', 'wrench', 'plier',
        'tape measure', 'level tool', 'ladder', 'toolkit', 'tool set',
        'paint ', 'paintbrush', 'roller brush', 'sandpaper', 'putty',
        'curtain rod', 'towel rail', 'toilet brush', 'bath accessories',
        'shower curtain', 'shower head', 'faucet', 'tap ',
        'kitchen cabinet', 'kitchen shelf', 'utensil', 'spatula', 'ladle',
        'pot ', 'pan ', 'frying pan', 'wok ', 'casserole', 'baking tray',
        'cutting board', 'knife ', 'peeler', 'grater', 'colander',
        'plate ', 'bowl ', 'cup ', 'mug ', 'glass ', 'jug ', 'flask',
        'tupperware', 'lunch box', 'food container', 'meal prep container',
        'garden', 'gardening', 'hose ', 'lawn mower', 'plant food',
        'fertilizer', 'pesticide', 'insecticide', 'mousetrap', 'bug spray'
      ]
    }
  ];

  /**
   * @param {string} description  The item's name / description string.
   * @returns {string}            One of the 8 category names.
   */
  return function classifyCategory(description) {
    if (!description || typeof description !== 'string') return 'Others';

    const lower = description.toLowerCase();

    for (const rule of RULES) {
      for (const keyword of rule.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          return rule.category;
        }
      }
    }

    return 'Others';
  };

})();
