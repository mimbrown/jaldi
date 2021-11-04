<template>
  <div class="test">
    Hello, {{ name }}!
  </div>
</template>

<script>
export default {
  setup() {
    return {
      name: 'World'
    };
  },
}
</script>

<style>
.test {
  color: red;
}
</style>