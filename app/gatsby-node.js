const dotenv = require("dotenv");

if (process.env.environment !== "production") dotenv.config();

const {
  awsAccessKeyId,
  awsSecretAccessKey,
  awsS3BucketName,
  awsS3DirectoryName,
} = process.env;

const AWS = require("aws-sdk");
AWS.config.update({
  accessKeyId: awsAccessKeyId,
  secretAccessKey: awsSecretAccessKey,
});
const s3 = new AWS.S3();

const listRepositories = async () => {
  const data = await s3
    .listObjects({
      Bucket: awsS3BucketName,
      Prefix: `${awsS3DirectoryName}/`,
    })
    .promise();

  const repositoryPromises = data.Contents.filter(item =>
    item.Key.endsWith(".json"),
  ).map(async item => {
    try {
      const data = await s3
        .getObject({
          Bucket: awsS3BucketName,
          Key: item.Key,
        })
        .promise();
      return JSON.parse(data.Body.toString());
    } catch (e) {
      console.error(e);
      return undefined;
    }
  });

  const repositories = (await Promise.all(repositoryPromises)).filter(
    repository => !!repository,
  );
  return repositories;
};

exports.sourceNodes = async ({
  actions,
  createNodeId,
  createContentDigest,
  cache,
}) => {
  try {
    const cacheKey = "s3-repositories";
    let obj = await cache.get(cacheKey);

    let repositories = null;

    if (!obj) {
      obj = { created: Date.now() };
      repositories = await listRepositories();
      obj.data = repositories;
    } else if (Date.now() > obj.lastChecked + 3600000) {
      repositories = await listRepositories();
      obj.data = repositories;
    } else {
      console.log("INFO: Used nodes cache");
      repositories = obj.data;
    }
    obj.lastChecked = Date.now();

    await cache.set(cacheKey, obj);

    const { createNode } = actions;

    repositories.forEach(repository => {
      try {
        const nodeContent = JSON.stringify(repository);
        const nodeMeta = {
          id: createNodeId(`repository-${repository.id}`),
          parent: null,
          children: [],
          internal: {
            type: `Repository`,
            mediaType: `text/html`,
            content: nodeContent,
            contentDigest: createContentDigest(repository),
          },
        };
        const node = Object.assign({}, repository, nodeMeta);
        createNode(node);
      } catch (e) {
        console.error(`Couldn't create node for ${repository.id}`);
        console.error(e);
      }
    });
  } catch (e) {
    console.error(e);
  }
};

const { createRemoteFileNode } = require("gatsby-source-filesystem");
const fetch = require("node-fetch");

exports.createSchemaCustomization = ({ actions }) => {
  const { createTypes } = actions;
  createTypes(`
    type Repository implements Node {
      image: File @link(from: "image___NODE")
    }
  `);
};

const urlIsImage = async url => {
  try {
    const response = await fetch(url);
    if (!!response && response.ok) {
      const contentType = response.headers.get("Content-Type");
      return contentType.includes("image");
    }
    return false;
  } catch {
    return false;
  }
};

exports.onCreateNode = async ({
  node,
  actions: { createNode },
  store,
  cache,
  createNodeId,
}) => {
  const imageUrls = node.image_urls;
  if (
    node.internal.type === "Repository" &&
    imageUrls !== null &&
    imageUrls.length > 0
  ) {
    try {
      let index = 0;
      let fileNode = null;
      let imageUrl = null;
      while (imageUrls.length > index && !fileNode) {
        imageUrl = imageUrls[index];
        if (await urlIsImage(imageUrl)) {
          fileNode = await createRemoteFileNode({
            url: imageUrl,
            parentNodeId: node.id,
            createNode,
            createNodeId,
            cache,
            store,
          });
        }
        index++;
      }
      if (fileNode) {
        node.image___NODE = fileNode.id;
      }
    } catch (e) {
      console.error(e);
    }
  }
};

const path = require(`path`);

const URLify = value =>
  !!value ? value.trim().toLowerCase().replace(/\s/g, "%20") : "";

const allRepositoryQuery = `
    {
      allRepository {
        nodes {
          name
          owner {
            name
          }
        }
      }
    }
  `;

const createRepositoryPage = ({ allRepository }, createPage) => {
  return allRepository.nodes.map(repository =>
    createPage({
      path: `${URLify(repository.owner.name)}/${URLify(repository.name)}`,
      component: path.resolve(`./src/templates/repository/index.jsx`),
      context: {
        ownerName: repository.owner.name,
        name: repository.name,
      },
    }),
  );
};

const pageSize = 20;
const createRepositoryPaginatedPages = ({ allRepository }, createPage) => {
  const pageCount = Math.ceil(allRepository.nodes.length / pageSize);

  return Array.from({ length: pageCount }).map((_, index) =>
    createPage({
      path: index === 0 ? "/" : `/${index + 1}`,
      component: path.resolve(`./src/templates/repositories/index.jsx`),
      context: {
        skip: index * pageSize,
        limit: pageSize,
        pageCount,
        currentPage: index + 1,
      },
    }),
  );
};

exports.createPages = async ({ graphql, actions }) => {
  const { createPage } = actions;

  const { data } = await graphql(allRepositoryQuery);
  createRepositoryPage(data, createPage);
  createRepositoryPaginatedPages(data, createPage);
};