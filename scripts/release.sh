#!/usr/bin/env bash

# 发布新版本：更新版本号、构建、生成 release/ 目录（脚本管理器自动更新读取的文件）、打 tag 并推送
#
# 用法：bash scripts/release.sh
# 发布后：
#  - release/ 目录随提交推送到 main 分支，脚本管理器和脚本内的更新提示都从这里读取；
#  - 推送 tag 会触发 GitHub Actions，自动创建 Release 并附带脚本文件。

set -e

# 从控制台获取需要发布的版本
read -p "请输入需要发布的版本(例如: 4.12.47): " version
# 判断是否为空
if [ -z "$version" ]; then
    echo "版本号不能为空!"
    exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)

# 确认是否发布版本
read -p "确认在分支 $branch 上发布版本 $version ? [y/n]: " isRelease

if [ "$isRelease" = "y" ]; then
    echo "版本发布 $version"

    # 代码检查
    npm run lint
    # 更新版本（不自动打 tag，下面统一提交）
    npm version "$version" --no-git-tag-version
    # 本地构建（同时生成 release/ 目录）
    echo "本地构建"
    npm run build
    # 更新日志
    npm run changelog
    npm run changelog:simplify
    npm run changelog:current

    # 保存：release/ 必须一起提交，否则脚本管理器检查不到新版本
    git add package.json CHANGELOG.md CHANGELOG_SIMPLIFIED.md CHANGELOG_CURRENT.md release
    git commit -m "version release $version"
    git tag "$version"

    echo "开始发布"
    git push origin "$branch" --tags
    echo "$version 发布成功"
elif [ "$isRelease" = "n" ]; then
    echo "取消发布"
else
    echo "输入有误"
fi
