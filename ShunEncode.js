;(function (M) {
  if (typeof define !== 'function'
      && typeof module !=='undefined'
      && typeof require === 'function') {
    var define = require('amdefine')(module);
  }
  if (typeof define==='function') {
    define(M);
  } else {
    this.ShunEncode=M();
  }
})(function () {


/**
* type Range=[Int,Int,Int,Int]  # [Low,High,Size,Random]  Random为附加的随机值，可用作偏移量
 */


var Charset=[ // [Range]
  [0x30,0x39,10,0],  // 0-9
  [0x41,0x5A,26,0],  // A-Z
  [0x61,0x7A,26,0],  // a-z
  // CJK汉字Unicode区间
  [0x3400,0x4DB5,6582,0],
  [0x4E00,0x9FBB,20924,0], //选这个区间的汉字作为随机数的编码
  [0xF900,0xFA2D,361,0],
  [0xFA30,0xFA6A,59,0],
  [0xFA70,0xFAD9,106,0],
  [0x20000,0x2A6D6,42711,0],
  [0x2F800,0x2FA1D,542,0]
];

// 选用下标为4的汉字区间中一个字作为随机数的编码，偏移不大于 0xFFFF << 2 >> 4，留两个 Bit给LZM、Huffman
var RAND_RANGE_SIZE=0xFFFF << 2 >> 4,
    RAND_RANGE=[0x4E00,0x4E00+RAND_RANGE_SIZE];

/**
 * Set random
 * @param {Float} r random number
 */
Charset.setRand=function (r) {
  for (var i=0,l=Charset.length;i<l;i++) {
    Charset[i][3]=Math.ceil(r*(Charset[i][2]-1));
  }
};


Charset.regex=/[0-9A-Za-z\u3400-\u4DB5\u4E00-\u9FBB\uF900-\uFA2D\uFA30-\uFA6A\uFA70-\uFAD9\uD800-\uDBFF\uDC00-\uDFFF]+/g;

/**
 * 通过字符的code point查找其对应区间
 * @param {Int} cp Unicode Code Point
 * @return {Range} 返回区间
 */
Charset.from=function (cp) {
  var a=Charset,n=a.length,i=cp>0xFF?3:0,lo,hi;
  for (;i<n;i++) {
    lo=a[i][0];hi=a[i][1];
    if (cp<lo) return null;
    if (lo<=cp && cp<=hi) return a[i];
  }
  return null;
};




function BitStream(s) {
  this.string=s;
  this.bitIndex=0;
  this.bitSize=s.length*16;
}
BitStream.prototype={
  EOF:-1,
  /**
   * @return {0|1|-1}  -1 indicate EOF
   */
  readBit:function () {
    var bi=this.bitIndex;
    if (bi>=this.bitSize) {
      return -1;
    }
    var i=bi/16|0;
    var c=this.string[i];
    var mask=1<<(15-bi%16);
    this.bitIndex++;
    return (ord(c)&mask)?1:0;
  },
  /**
   * @param {Int} n read N bits
   * @return {[Bit]}  bit string e.g. "01010111"
   */
  read:function (n) {
    var bits='',b;
    while (n--) {
      b=this.readBit();
      if (b===-1) return b;
      bits+=b;
    }
    return bits;
  },
  /**
   * @return {UInt|-1} -1 indicate EOF
   */
  readByte:function () {
    return parseInt(this.read(8),2);
  }
};


/**
 * 简单LZM压缩
 */
var LZM={
  MASK: 1<<15,
  encode:function (s) {
    var charStat=Object.create(null),i,size=s.length;
    for (i=0;i<size;i++) charStat[s[i]]=1;
    var chars=Object.keys(charStat).sort();

    //找个区间用于压缩编码
    var lo=0,hi=0,
        expectRangeSize=Math.min(size,0x8000);
    if (chars[0]!=='\u0000') chars.unshift('\u0000');
    if (chars[chars.length-1]!=='\uFFFF') chars.push('\uFFFF');
    for (var i=0,l=chars.length-1;i<l;i++) {
      lo=ord(chars[i])+1;hi=ord(chars[i+1])-1;
      if (hi-lo > expectRangeSize) break;
    }
    if (lo===hi) return false;

    lo=chr(lo);hi=chr(hi);

    var st=Object.create(null),
        codeChar=lo,
        i,stack=[s[0]];
    for (i=0;i<size;i++) st[s[i]]=Object.create(null);

    var prefix,c,remain='';
    for (i=1;i<size;i++) {
      c=s[i]; prefix=stack[0];
      if (st[prefix][c]) {
        stack[0]=st[prefix][c];
      } else {
        stack.unshift(c);
        if (codeChar<=hi) {
          st[prefix][c]=codeChar;
          st[codeChar]=Object.create(null);
          codeChar=succ(codeChar);
        } else { // when prefix code overflow
          remain=s.slice(i+1);
          break;
        }
      }
    }
    stack.reverse();
    return lo+hi+stack.join('')+remain;
  },
  decode:function (s) {
    var lo=s[0],hi=s[1];
    s=s.slice(2);
    var st=Object.create(null),
        codeChar=lo,size=s.length,i,
        stack=[s[0]];

    for (i=0;i<size;i++) st[s[i]]=s[i];

    var prefix=s[0],remain='',c,v;
    for (i=1;i<size;i++) {
      c=s[i]; v=st[c];
      if (codeChar===c) { // "ABABABA" case: "AB13", AB=1 BA=2 1A=3
        v=prefix+prefix[0];
      }
      stack.unshift(v);
      if (codeChar <= hi) {
        st[codeChar]=prefix+v[0];
        codeChar=succ(codeChar);
      } else {
        remain=s.slice(i+1);
        break;
      }
      prefix=v;
    }
    stack.reverse();
    return stack.join('')+remain;
  }
};

var Huffman={
  MASK:1<<14,
  encode:function (s) {
    var trie=this._buildTrie(s);
    var dict=this._buildDict(trie);
    var resultBits=this._dumpTrie(trie);

    for (var i=0,byte,size=s.length,cp;i<size;i++) {
      cp=ord(s[i]);
      byte = cp >> 8;
      resultBits += dict[byte];
      byte = cp & 0x00FF;
      resultBits += dict[byte];
    }

    var pad=(16-(resultBits.length+4)%16)%16;
    resultBits=padz(pad.toString(2),4)+resultBits;//最前4Bit指示填充
    if (pad) {
      resultBits+=repeats('0',pad);
    }

    var result=[];
    for (var i=0,l=resultBits.length;i<l;i+=16) {
      result.push(chr(parseInt(resultBits.substr(i,16),2)));
    }

    return result.join('');
  },
  decode:function (s) {
    var stream=new BitStream(s);
    var pad=parseInt(stream.read(4),2);
    stream.bitSize-=pad;

    var root=this._readTrie(stream);
    var b,bytes=[],node=root;
    while ((b=stream.readBit()) !==-1) {
      node=b?node.right:node.left;
      if (!node) break;
      if (node.isLeaf) {
        bytes.push(node.value);
        node=root;
      }
    }

    var result='';
    for (var i=0,l=bytes.length;i<l;i+=2) {
      result+= chr((bytes[i]<<8)+bytes[i+1]);
    }
    return result;
  },
  _buildTrie:function (s) {
    var byteStat=Object.create(null);
    for (var i=0,byte,size=s.length,cp;i<size;i++) {
      cp=ord(s[i]);
      byte = cp >> 8;
      byteStat[byte] = (byteStat[byte] || 0) + 1;
      byte = cp & 0x00FF;
      byteStat[byte] = (byteStat[byte] || 0) + 1;
    }

    var queue=[];
    for (var k in byteStat)
      queue.push({
        value:+k, freq:byteStat[k], isLeaf:true
      });

    // [Byte] order by frequency
    queue.sort(function (a,b) {
      return a.freq-b.freq; // sort by frequency asc(low freq preceed)
    });

    while (queue.length > 1) {
      var a=queue.shift();
      var b=queue.shift();
      var parent={freq:a.freq+b.freq, left:a, right:b};
      var i=0;
      while (queue[i] && queue[i].freq<parent.freq) i++;
      queue.splice(i,0,parent);
    }

    return queue.shift();
  },

  _buildDict:function (trie) {
    var dict=Object.create(null);
    build(trie,'');
    return dict;

    function build(node,binCode) {
      if (node.isLeaf) {
        dict[node.value]=binCode;
      } else {
        build(node.left,binCode+'0');
        build(node.right,binCode+'1');
      }
    }
  },
  _dumpTrie:function (trie) {
    var bits='';
    dump(trie);
    return bits;

    function dump(node) {
      if (node.isLeaf) {
        bits+='1'+padz(node.value.toString(2),8);
      } else {
        bits+='0';
        dump(node.left);
        dump(node.right);
      }
    }
  },
  _readTrie:function (s) {
    return read();
    function read() {
      if (s.readBit()) {
        return {value:s.readByte(),isLeaf:true};
      }
      return {left:read(),right:read()};
    }
  }
};


  //正能量字典
var ZEnergyDict=_buildZEnergyDict("超强太壮牛更很增盈升赞顶发拼必全好伟最够胜巨正浓劲越激欣战志哥爷信紫雷茂爱巧貌恋情敏恳煌瞩给力华忠厚幸女公甜望梦长倍谐远丽汇涌南若快满潮礼才阔帝清美珍跃善谊炎七热勤勇羡达显饭吃值慷白宝帅神友倩靓心锐同豁亲日寿精烈放春英妮百旺良祥著朗广首秀博万倡核又恬进馨仁康妙弘喜可如亮德福禄财乐惠优欢泰吹宗圆足歌操羊昭会团笑感撑想聚透兴适和展雅蕴诚追温颂三十铁富宜充有慧直金守饱撼定愉威思银雄盼立活赶致敢亿健火阳天昂常近红八励豪柔新千鲜先彩生萌智行创设来享捧聪齐开振灵风迎建学花拓唤武浩碧宽持慨奋上做坚恩海前加照靠二笃慕易高贡大响");

function _buildZEnergyDict(s) {
  s=new String(s);
  for (var i=0,l=s.length;i<l;i++) s[s[i]]=i;
  return s;
}

/**
 * 超级正能量爆发编码
 */
var ZEnergy={
  ZTag:'正', //正能量标识
  regex:new RegExp('^['+ZEnergyDict+']+$'),
  negativeRegex:new RegExp('[^'+ZEnergyDict+']+','g'),
  isValid:function (s) {
    return this.ZTag===s[0];
  },
  encode:function (s) {
    var result='';
    for (var i=0,l=s.length,cp;i<l;i++) {
      cp = ord(s[i]);
      result += ZEnergyDict[cp >> 8] + ZEnergyDict[cp&0x00FF];
    }
    //return this.ZTag[(Math.random()*0xFFFF|0)% this.ZTag.length]+result;
    return this.ZTag+result;
  },
  decode:function (s) {
    s=s.slice(1).replace(this.negativeRegex,'');
    var result='';
    for (var i=0,l=s.length;i<l;i+=2) {
      result+=chr((ZEnergyDict[s[i]]<<8)+(ZEnergyDict[s[i+1]]));
    }
    return result;
  }
};

var Codecs={
  LZM:LZM,
  Huffman:Huffman,
  ZEnergy:ZEnergy
};

var _;
var ShunEncode=_={
  Codecs:Codecs,
  /**
   * @param {String} s 要进行编码的字符串
   * @param {Boolean} [weak=false] 不开启正能量模式
   * @return 编码后的字符串
   */
  encode:function (s,weak) {
    var rand=Math.ceil(Math.random()*(RAND_RANGE_SIZE-1));
    Charset.setRand(rand);

    s=s.replace(Charset.regex,function (chars) { //随机混淆
      for (var i=0,l=chars.length,cp,result='',range;i<l;i++) {
        cp=codePointAt(chars,i);
        if (cp>0xFFFF) i++;
        range=Charset.from(cp);
        cp=shift(cp,range);
        cp=mirror(cp,range);
        result+=fromCodePoint(cp);
      }
      return result;
    });

    if (weak) {
      var randCharCode=rand+RAND_RANGE[0];
      return chr(randCharCode)+s;
    }

    var mask=0;
    var zs=LZM.encode(s);
    if (zs===false || zs.length>s.length) {
      console.warn("LZM encode failed!\n\tOld Size:"+s.length+"\n\tNew Size:"+(zs && zs.length));
    } else {
      s=zs; mask=mask|LZM.MASK;
    }

    var hs=Huffman.encode(s);
    if ((hs===false || hs.length>=s.length)) {
      console.warn("Huffman encode failed!\n\tOld Size:"+s.length+"\n\tNew Size:"+(hs && hs.length));
    } else {
      s=hs; mask=mask|Huffman.MASK;
    }
    mask+=rand;
    s=chr(mask)+s;
    return ZEnergy.encode(s);
  },
  /**
   * @param {String} s 要进行解码的字符串
   * @return {String|Boolean} 还原后字符串，格式不正确时返回 false
   */
  decode:function (s) {
    s=trim(s);
    if (s.length<2) return false;
    if (ZEnergy.isValid(s)) {
      s=ZEnergy.decode(s);
      if (!s) return false;
      var mask=ord(s[0]);
      var rand=mask & RAND_RANGE_SIZE;// range size = 0xFFFF << 2 >> 4
      s=s.slice(1);
      if (mask & Huffman.MASK) {
        s=Huffman.decode(s);
      }
      if (mask & LZM.MASK) {
        s=LZM.decode(s);
      }
    } else {
      var randChar=s[0];
      var rand=randChar.charCodeAt(0)-RAND_RANGE[0];
      s=s.slice(1);
    }

    if (rand <1 || RAND_RANGE_SIZE<rand) return false;
    Charset.setRand(-rand);

    return s.replace(Charset.regex,function (chars) {
      for (var i=0,l=chars.length,cp,result='',range;i<l;i++) {
        cp=codePointAt(chars,i);
        if (cp>0xFFFF) i++;
        range=Charset.from(cp);
        if (range) {
          cp=mirror(cp,range);
          cp=shift(cp,range);
        }
        result+=fromCodePoint(cp);
      }
      return result;
    });
  }
};

function fromCodePoint(n) {
  if (n > 0xFFFF) {
    n-=0x10000;
    return String.fromCharCode((n >> 10)+0xD800)+
           String.fromCharCode(n % 0x400 + 0xDC00);
  }
  return String.fromCharCode(n)
}

function codePointAt(s,i) {
  i = i || 0;
  var l=s.length;
  if (i>=l) return NaN;
  var first=s.charCodeAt(i);
  if (0xD800 <= first && first <= 0xDBFF && i+1 < l) {
    var second=s.charCodeAt(i+1);
    if (0xDC00 <= second && second <= 0xDFFF) {
      return ((first-0xD800)*0x400)+second+9216;// 0x10000-0xDC00=9216
    }
  }
  return first;
}


/**
 * 区间Caesar偏移编码
 */
function shift(cp,range) {
  var lo=range[0],randOffset=range[3],size=range[2];
  return ((cp - lo + randOffset) % size + size ) % size + lo;
}


/**
 * 镜像编码 Flip
 */
function mirror(cp,range) {
  var lo=range[0],hi=range[1];
  return lo-cp+hi;
}

_.trim=trim;
function trim(s) {
  return s.replace(/^\s+/,'').replace(/\s+$/,'');
}

_.succ=succ;
function succ(c) {
  return String.fromCharCode((c.charCodeAt(0)+1)%0xFFFF);
}
_.pred=pred;
function pred(c) {
  return String.fromCharCode((c.charCodeAt(0)-1+0xFFFF)%0xFFFF);
}
_.ord=ord;
function ord(c) {return c.charCodeAt(0)}
_.chr=chr;
function chr(n) {return String.fromCharCode(n)}
_.repeats=repeats;
function repeats(s,n) {return new Array(n+1).join(s)}
_.padz=padz;
function padz(s,n) {return s.length>=n?s:repeats('0',n-s.length)+s}


return ShunEncode;

});


