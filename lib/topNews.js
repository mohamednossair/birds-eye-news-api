const axios = require("axios");
const tsvToJSON = require("./tsvJSON");
const _ = require("lodash");
const _lib = require("./helpers");
const striptags = require("striptags");
const BatchOfTags = require("../models/batchOfTags.js");
const Article = require("../models/article.js");
const moment = require("moment");
const sites = require("../sites");
const shuffle = require("shuffle-array");

module.exports = async () => {
  // ...batches from the previous week
  const batches = await getBatches();

  // most common words
  const topTags = batches[0].tags.sort((a, b) => {
    let aCount = a ? ("sourceCount" in a ? a.sourceCount : 0) : 0;
    let bCount = b ? ("sourceCount" in b ? b.sourceCount : 0) : 0;
    if (aCount < bCount) {
      return 1;
    } else if (bCount < aCount) {
      return -1;
    } else {
      return 0;
    }
  });

  const articles = await getArticles();

  // ....top topic
  let topicsToGet = 2;
  const topics = [];
  for (let i = 0; i < topicsToGet; i++) {
    let topicIndex = i,
      newTopicFound = false,
      avoidInfinity = 0;

    while (!newTopicFound && avoidInfinity < 100) {
      let skipTopic = topics.find(topic => {
        return (
          topic.main.term.includes(topTags[topicIndex].term) ||
          topTags[topicIndex].term.includes(topic.main.term) ||
          topTags[topicIndex].sourceCount < 20
        );
      });

      if (skipTopic) {
        avoidInfinity++;
        topicIndex++;
      } else {
        let topic = await getTopic(topicIndex, topTags, articles);
        topics.push(topic);
        newTopicFound = true;
        i = topicIndex;
      }
    }
  }

  return { batches, topTags, topics, articles };
};

// get topic
const getTopic = async (index, tags, articles) => {
  // ok, start with the main tag
  const top = tags[index];

  // find any and all related terms
  let otherRelated = tags.filter(tag => {
    const alreadyRelated = top.related.find(item => {
      return tag.term === item.term;
    });

    return (
      (tag.term.includes(top.term) || top.term.includes(tag.term)) &&
      tag.term !== top.term &&
      !alreadyRelated
    );
  });
  let related = [...top.related, ...otherRelated].filter(tag => {
    return tag.term !== top.term;
  });

  // see what sources have covered the main topic
  let groupedByCoverage = groupByCoverage(articles, top);

  // get politics articles
  const filteredPolitics = articles.politics.filter(article => {
    return (
      article.title.toLowerCase().includes(top.term) ||
      article.description.toLowerCase().includes(top.term)
    );
  });
  const filteredOpinions = articles.opinion.filter(article => {
    return (
      article.title.toLowerCase().includes(top.term) ||
      article.description.toLowerCase().includes(top.term)
    );
  });
  const articleCount = [...filteredPolitics, ...filteredOpinions].length;

  let topRelated = related.find(tag => {
    return !tag.term.includes(top.term) && !top.term.includes(tag.term);
  });

  let previewArticles = filteredPolitics
    .filter(article => {
      // if (article.image) {
      return (
        article.title.toLowerCase().includes(top.term) &&
        (article.title.toLowerCase().includes(topRelated.term) ||
          article.description.toLowerCase().includes(topRelated.term)) &&
        article.image !== null &&
        article.description.length > 0
      );
      //   );
      // } else {
      //   return false;
      // }
    })
    .slice(0, 4);

  let sitesUsedForOpinions = [];
  let previewOpinions = [];

  for (let article of filteredOpinions) {
    if (previewOpinions.length > 3) {
      break;
    }

    if (sitesUsedForOpinions.indexOf(article.siteName) < 0) {
      previewOpinions.push(article);
      sitesUsedForOpinions.push(article.siteName);
    }
  }

  // get some more articles that haven't been used yet
  // let relatedArticles = [],
  //   tagsAlreadyUsed = [top.term];
  // for (let tag of related) {
  //   let tagAlreadyUsed = tagsAlreadyUsed.find(item => {
  //     return tag.term.includes(item.term) && item.term.includes(tag.term);
  //   });
  //
  //   if (!tagAlreadyUsed) {
  //     tagsAlreadyUsed.push(tag.term);
  //     let article = filteredPolitics.find(article => {
  //       return (
  //         article.title.toLowerCase().includes(top.term) ||
  //         article.description.toLowerCase().includes(top.term)
  //       );
  //     });
  //
  //     relatedArticles.unshift(article);
  //   }
  // }

  let articlesAlreadyUsed = [...previewArticles, ...previewOpinions];
  let moreArticles = [];

  for (let article of filteredPolitics) {
    if (moreArticles.length > 3) {
      break;
    }

    let alreadyUsed = articlesAlreadyUsed.find(item => {
      return item.id === article.id;
    });

    if (!alreadyUsed) {
      moreArticles.push(article);
    }
  }

  return {
    main: top,
    percentageFreq: articleCount / articles.combined.length,
    preview: {
      politics: previewArticles,
      opinions: previewOpinions,
      more: moreArticles
    },
    related,
    articles: {
      politics: filteredPolitics,
      opinions: filteredOpinions
    },
    sourceCoverage: groupedByCoverage
  };
};

// batches from the previous week
const getBatches = async () => {
  const batches = await BatchOfTags.find(
    {},
    {},
    { sort: { created_at: -1 } },

    function(err, batch) {
      return batch;
    }
  ).limit(24 * 4);

  // let sorted = batches.sort((a, b) => {
  //   if (moment(a.created_at).isAfter(moment(b.created_at))) {
  //     return -1;
  //   } else if (moment(b.created_at).isAfter(moment(a.created_at))) {
  //     return 1;
  //   } else {
  //     return 0;
  //   }
  // });

  return batches;
};

// articles
const getArticles = async () => {
  let politicsArticles = [];

  for (let site of sites) {
    let hasPolitics = site.rss.find(feed => {
      return feed.category === "politics";
    });
    if (hasPolitics) {
      let params = {
        siteName: site.name,
        category: "politics",
        created_at: {
          $gte: new Date(new Date().getTime() - 15 * 24 * 60 * 60 * 1000)
        }
      };

      let articles = await Article.find(
        params,
        {},
        { sort: { created_at: -1 } },
        function(err, articles) {
          return articles;
        }
      ).limit(10);

      politicsArticles = politicsArticles.concat(articles);
    }
  }

  let opinionArticles = [];

  for (let site of sites) {
    let hasOpinions = site.rss.find(feed => {
      return feed.category === "opinion";
    });
    if (hasOpinions) {
      let params = { siteName: site.name, category: "opinion" };
      let articles = await Article.find(
        params,
        {},
        { sort: { created_at: -1 } },
        function(err, articles) {
          return articles;
        }
      ).limit(10);

      opinionArticles = opinionArticles.concat(articles);
    }
  }

  return {
    politics: shuffle(politicsArticles),
    opinion: shuffle(opinionArticles),
    combined: shuffle([...politicsArticles, ...opinionArticles])
  };
  // return {};
};

const groupByCoverage = (articles, tag1, tag2) => {
  let grouped = _.partition(sites, site => {
    return articles.combined.find(article => {
      return (
        article.siteName === site.name &&
        (article.title.toLowerCase().includes(tag1.term) ||
          article.description.toLowerCase().includes(tag1.term)) &&
        (tag2
          ? article.title.toLowerCase().includes(tag2.term) ||
            article.description.toLowerCase().includes(tag2.term)
          : true)
      );
    });
  });

  return {
    tag1: tag1,
    tag2: tag2,
    sourceCount: sites.length,
    yes: grouped[0],
    no: grouped[1]
  };
};