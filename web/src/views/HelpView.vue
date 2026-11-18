<script setup lang="ts">
/**
 * 心理支持资源页。
 *
 * 存在的理由：AI 审核会把疑似自伤的内容标记为 need_support，
 * 这时候光拦下来是没用的，必须给出口。所以这个页面不是装饰，
 * 是审核链路的一部分。
 */
import { RouterLink } from 'vue-router';
</script>

<template>
  <div class="page narrow">
    <div class="page-head">
      <div>
        <h1 class="page-title">如果你最近不太好</h1>
        <p class="page-sub">这里是一些真实可用的资源</p>
      </div>
    </div>

    <div class="alert info">
      看到你点进这里，可能是你自己需要，也可能是你担心某个人。
      不管哪种，先深呼吸一下，下面这些是真的能找到人的。
    </div>

    <div class="card pad-lg mb-3">
      <h3>在校内</h3>
      <div class="col" style="gap: 12px">
        <div>
          <div class="bold">学校心理健康教育与咨询中心</div>
          <p class="small muted mb-0">
            绝大多数高校都有，且对学生免费。可以打电话预约，也可以直接去问。
            如果不知道电话，搜「学校名 + 心理咨询中心」，或者去学生处问。
          </p>
        </div>
        <div>
          <div class="bold">辅导员 / 班主任</div>
          <p class="small muted mb-0">
            别把他们只当成管考勤的。他们手里有转介资源，也见过很多类似的情况。
          </p>
        </div>
        <div>
          <div class="bold">校医院 / 医务室</div>
          <p class="small muted mb-0">如果影响到睡眠和进食，先去看看身体状态。</p>
        </div>
      </div>
    </div>

    <div class="card pad-lg mb-3">
      <h3>24 小时热线（中国大陆）</h3>
      <div class="col" style="gap: 12px">
        <div>
          <div class="bold">全国心理援助热线：12356</div>
          <p class="small muted mb-0">国家卫健委统一热线，24 小时接听。</p>
        </div>
        <div>
          <div class="bold">北京心理危机研究与干预中心：010-82951332</div>
          <p class="small muted mb-0">24 小时，全国可拨。</p>
        </div>
        <div>
          <div class="bold">希望 24 热线：400-161-9995</div>
          <p class="small muted mb-0">24 小时，按 1 转学生专线。</p>
        </div>
        <div>
          <div class="bold">紧急情况：120 / 110</div>
          <p class="small muted mb-0">如果当下有危险，请直接打这两个，不要犹豫。</p>
        </div>
      </div>
    </div>

    <div class="card pad-lg mb-3">
      <h3>如果你是担心别人的那个人</h3>
      <ul class="small" style="padding-left: 20px; margin: 0">
        <li>直接问「你最近是不是不太好」，比绕着弯试探更有用。问不会害人。</li>
        <li>多听，少给建议。大多数时候人需要的是被听见，不是被指导。</li>
        <li>不要承诺保密。如果对方有危险，帮他找到专业的人比守住秘密重要。</li>
        <li>陪着去预约、去咨询，比说「你要去看医生」有效得多。</li>
        <li>你不需要独自扛。可以告诉辅导员，也可以打上面的热线问该怎么办。</li>
      </ul>
    </div>

    <div class="center">
      <RouterLink to="/" class="btn ghost">返回首页</RouterLink>
    </div>
  </div>
</template>
